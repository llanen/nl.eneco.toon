'use strict';

const Homey = require('homey');
const { OAuth2Device, OAuth2Token, OAuth2Util } = require('homey-oauth2app');

const TEMPERATURE_STATES = {
  comfort: 0,
  home: 1,
  sleep: 2,
  away: 3,
  holiday: 4, // Reported state by API but not settable
  none: -1
};

const THERMOSTAT_PROGRAM_STATES = {
  off: 0,
  on: 1,
  override: 2,
  holiday: 4,
  none: -1
};

// TODO: remove flow cards (>=2.0.0 compatible)
// TODO: remove OAuth2 migration code after a while
class ToonDevice extends OAuth2Device {

  async onOAuth2Init() {
    this.log('onOAuth2Init()');

    // Indicate Homey is connecting to Toon
    await this.setUnavailable(Homey.__('authentication.connecting'));

    // Store raw data
    this.gasUsage = {};
    this.powerUsage = {};
    this.thermostatInfo = {};
    this.temperatureStatesMap = {};

    // Register capability listeners
    this.registerCapabilityListener('temperature_state', ToonDevice.debounce(this.onCapabilityTemperatureState.bind(this), 500));
    this.registerCapabilityListener('target_temperature', ToonDevice.debounce(this.onCapabilityTargetTemperature.bind(this), 500));

    // Fetch initial data update and start listening for webhooks
    await Promise.all([this.getStatusUpdate(), this.registerWebhookSubscription()])
      .catch(err => this.error('onOAuth2Init() -> error occured while fetching status update or registering webhook subscription', err.message || err.toString()));

    await this.setAvailable();

    this.log('onOAuth2Init() -> success');
  }

  /**
   * Method that takes a sessionId and configId, finds the OAuth2Client based on that, then binds the new OAuth2Client
   * instance to this HomeyDevice instance. Basically it allows switching OAuth2Clients on a HomeyDevice.
   * @param {string} sessionId
   * @param {string} configId
   * @returns {Promise<void>}
   */
  async resetOAuth2Client({ sessionId, configId }) {

    // Store updated client config
    await this.setStoreValue('OAuth2SessionId', sessionId);
    await this.setStoreValue('OAuth2ConfigId', configId);

    // Check if client exists then bind it to this instance
    let client;
    if (Homey.app.hasOAuth2Client({ configId, sessionId })) {
      client = Homey.app.getOAuth2Client({ configId, sessionId });
    } else {
      this.error('OAuth2Client reset failed');
      return this.setUnavailable(Homey.__('authentication.re-login_failed'));
    }

    // Rebind new oAuth2Client
    this.oAuth2Client = client;

    // Check if device agreementId is present in OAuth2 account
    const agreements = await this.oAuth2Client.getAgreements();
    if (Array.isArray(agreements) &&
      agreements.find(agreement => agreement.agreementId === this.id)) {
      return this.setAvailable();
    }
    return this.setUnavailable(Homey.__('authentication.device_not_found'));
  }

  /**
   * Getter for agreementId.
   * @returns {*}
   */
  get id() {
    return this.getData().agreementId;
  }

  /**
   * This method will be called when the target temperature needs to be changed.
   * @param temperature
   * @param options
   * @returns {Promise}
   */
  onCapabilityTargetTemperature(temperature, options) {
    this.log('onCapabilityTargetTemperature() ->', 'temperature:', temperature, 'options:', options);
    return this.setTargetTemperature(Math.round(temperature * 2) / 2);
  }

  /**
   * This method will be called when the temperature state needs to be changed.
   * @param state
   * @param resumeProgram Abort or resume program
   * @returns {Promise}
   */
  onCapabilityTemperatureState(state, resumeProgram) {
    this.log('onCapabilityTemperatureState() ->', 'state:', state, 'resumeProgram:', resumeProgram);
    return this.updateState(state, resumeProgram);
  }

  /**
   * Method that will request a subscription for webhook events for the next hour.
   * @returns {Promise<void>}
   */
  async registerWebhookSubscription() {
    this.log('registerWebhookSubscription()');

    // Refresh webhooks after 15 minutes
    clearTimeout(this._registerWebhookSubscriptionTimeout);
    this._registerWebhookSubscriptionTimeout = setTimeout(() => this.registerWebhookSubscription(), 1000 * 60 * 15);

    try {
      // Start new subscription
      await this.oAuth2Client.registerWebhookSubscription({
        id: this.id,
        homeyId: await Homey.ManagerCloud.getHomeyId()
      });
      await this.setWarning(null); // Unset warning
    } catch (err) {
      this.error('Failed to register webhook subscription, reason', err.message || err.toString());

      // Set warning on device that data might not be coming in
      await this.setWarning(Homey.__('api.error_webhook_registration'));
    }
  }

  /**
   * This method will retrieve temperature, gas and electricity data from the Toon API.
   * @returns {Promise}
   */
  async getStatusUpdate() {
    try {
      const data = await this.oAuth2Client.getStatus({ id: this.id });
      this.processStatusUpdate({ body: { updateDataSet: data } });
    } catch (err) {
      this.error('getStatusUpdate() -> error, failed to retrieve status update', err.message);
    }
  }

  /**
   * Set the state of the device, overrides the program.
   * @param state ['away', 'home', 'sleep', 'comfort']
   * @param keepProgram - if true program will resume after state change
   */
  async updateState(state, keepProgram) {
    const stateId = TEMPERATURE_STATES[state];
    const data = { ...this.thermostatInfo, activeState: stateId, programState: keepProgram ? 2 : 0 };

    this.log(`updateState() -> set state to ${stateId} (${state}, temp: ${this.temperatureStatesMap[stateId]}), data: {activeState: ${stateId}}`);

    try {
      await this.oAuth2Client.updateState({ id: this.id, data });
      if (stateId >= 0) { // Do not try to update target temperature for unknown state
        await this.setCapabilityValue('target_temperature', Math.round((this.temperatureStatesMap[stateId] / 100) * 10) / 10);
      }
    } catch (err) {
      this.error(`updateState() -> error, failed to set temperature state to ${state} (${stateId})`, err.stack);
      throw new Error(Homey.__('capability.error_set_temperature_state', { error: err.message || err.toString() }));
    }

    this.log(`updateState() -> success setting temperature state to ${state} (${stateId})`);
    return state;
  }

  /**
   * PUTs to the Toon API to set a new target temperature
   * @param temperature temperature attribute of type integer.
   */
  async setTargetTemperature(temperature) {
    const data = { ...this.thermostatInfo, currentSetpoint: temperature * 100, programState: 2, activeState: -1 };

    this.log(`setTargetTemperature() -> ${temperature}`);

    if (!temperature) {
      this.error('setTargetTemperature() -> error, invalid temperature');
      throw new Error(Homey.__('capability.error_set_target_temperature', { error: err.message || err.toString() }))
    }

    this.setCapabilityValue('target_temperature', temperature).catch(this.error);

    return this.oAuth2Client.updateState({ id: this.id, data })
      .then(() => {
        this.log(`setTargetTemperature() -> success setting temperature to ${temperature}`);
        this.setCapabilityValue('temperature_state', 'none').catch(this.error);
        return temperature;
      }).catch(err => {
        this.error(`setTargetTemperature() -> error, failed to set temperature to ${temperature}`, err.stack);
        throw new Error(Homey.__('capability.error_set_target_temperature', { error: err.message || err.toString() }));
      });
  }

  /**
   * Enable the temperature program.
   * @returns {*}
   */
  enableProgram() {
    this.log('enableProgram()');
    const data = { ...this.thermostatInfo, programState: 1 };
    return this.oAuth2Client.updateState({ id: this.id, data })
      .then(...args => {
        this.log(`enableProgram() -> success`);
        return args;
      }).catch(err => {
        this.error(`enableProgram() -> error`, err.stack);
        throw new Error(Homey.__('capability.error_enable_program', { error: err.message || err.toString() }));
      });
  }

  /**
   * Disable the temperature program.
   * @returns {*}
   */
  disableProgram() {
    this.log('disableProgram()');
    const data = { ...this.thermostatInfo, programState: 0 };
    return this.oAuth2Client.updateState({ id: this.id, data })
      .then(...args => {
        this.log(`disableProgram() -> success`);
        return args;
      }).catch(err => {
        this.error(`disableProgram() -> error`, err.stack);
        throw new Error(Homey.__('capability.error_disable_program', { error: err.message || err.toString() }));
      });
  }

  /**
   * Method that handles processing an incoming status update, whether it is from a GET /status request or a webhook
   * update.
   * @param data
   * @private
   */
  processStatusUpdate(data) {
    this.log('processStatusUpdate', new Date().getTime());

    // Data needs to be unwrapped
    if (data && data.hasOwnProperty('body') && data.body.hasOwnProperty('updateDataSet')) {
      this.log(data.body);

      // Prevent parsing data from other displays
      if (data.body.hasOwnProperty('commonName') && data.body.commonName !== this.getData().id) return;

      // Setup register webhook subscription timeout
      if (typeof data.body.timeToLiveSeconds === 'number') {
        if (this._webhookRegistrationTimeout) clearTimeout(this._webhookRegistrationTimeout);
        this._webhookRegistrationTimeout = setTimeout(this.registerWebhookSubscription.bind(this), data.body.timeToLiveSeconds * 1000);
      }

      const dataRootObject = data.body.updateDataSet;

      // Keep updated list of thermostat state temperatures
      if (dataRootObject.hasOwnProperty('thermostatStates') &&
        Array.isArray(dataRootObject.thermostatStates.state)) {
        for (const { id, tempValue } of dataRootObject.thermostatStates.state) {
          this.temperatureStatesMap[id] = tempValue
        }
      }

      // Check for power usage information
      if (dataRootObject.hasOwnProperty('powerUsage')) {
        this._processPowerUsageData(dataRootObject.powerUsage);
      }

      // Check for gas usage information
      if (dataRootObject.hasOwnProperty('gasUsage')) {
        this._processGasUsageData(dataRootObject.gasUsage);
      }

      // Check for thermostat information
      if (dataRootObject.hasOwnProperty('thermostatInfo')) {
        this._processThermostatInfoData(dataRootObject.thermostatInfo);
      }
    }
  }

  /**
   * Method that handles the parsing of updated power usage data.
   * @param data
   * @private
   */
  _processPowerUsageData(data = {}) {
    // Store data object
    this.powerUsage = data;

    // Store new values
    if (data.hasOwnProperty('value')) {
      this.log('getThermostatData() -> powerUsage -> measure_power -> value:', data.value);
      this.setCapabilityValue('measure_power', data.value).catch(this.error);
    }

    // Store new values
    if (data.hasOwnProperty('dayUsage') && data.hasOwnProperty('dayLowUsage')) {
      const usage = (data.dayUsage + data.dayLowUsage) / 1000; // convert from Wh to KWh
      this.log('getThermostatData() -> powerUsage -> meter_power -> dayUsage:', data.dayUsage + ', dayLowUsage:' + data.dayLowUsage + ', usage:' + usage);
      this.setCapabilityValue('meter_power', usage).catch(this.error);
    }
  }

  /**
   * Method that handles the parsing of updated gas usage data.
   * TODO: validate this method once GasUsage becomes available.
   * @param data
   * @private
   */
  _processGasUsageData(data = {}) {
    // Store data object
    this.gasUsage = data;

    // Store new values
    if (data.hasOwnProperty('dayUsage')) {
      const meterGas = data.dayUsage / 1000; // Wh -> kWh
      this.log('getThermostatData() -> gasUsage -> meter_gas', meterGas);
      this.setCapabilityValue('meter_gas', meterGas).catch(this.error);
    }
  }

  /**
   * Method that handles the parsing of thermostat info data.
   * @param data
   * @private
   */
  _processThermostatInfoData(data = {}) {
    // Store data object
    this.thermostatInfo = data;

    // Store new values
    if (data.hasOwnProperty('currentDisplayTemp')) {
      this.setCapabilityValue('measure_temperature', Math.round((data.currentDisplayTemp / 100) * 10) / 10).catch(this.error);
    }
    if (data.hasOwnProperty('currentSetpoint')) {
      this.setCapabilityValue('target_temperature', Math.round((data.currentSetpoint / 100) * 10) / 10).catch(this.error);
    }
    if (data.hasOwnProperty('activeState')) {
	  var activeState = ToonDevice.getKey(TEMPERATURE_STATES, data.activeState);
	  // Ignore holiday as a valid state
	  if (activeState === 'holiday')
		activeState = 'none';
      this.setCapabilityValue('temperature_state', activeState).catch(this.error);
    }
    if (data.hasOwnProperty('programState')) {
	  const programState = ToonDevice.getKey(THERMOSTAT_PROGRAM_STATES, data.programState);
	  // For now only check for the holiday state
	  this.setCapabilityValue('holiday_active', programState === 'holiday').catch(this.error);
    }
  }

  /**
   * This method will be called when the device has been deleted, it makes
   * sure the client is properly destroyed and left over settings are removed.
   */
  async onOAuth2Deleted() {
    this.log('onOAuth2Deleted()');
    if (this.oAuth2Client) await this.oAuth2Client.unregisterWebhookSubscription({ id: this.id });
    clearTimeout(this._registerWebhookSubscriptionTimeout);
    clearTimeout(this._webhookRegistrationTimeout);
  }

  /**
   * Utility method that will return the first key of an object that matches a provided value.
   * @param obj
   * @param val
   * @returns {string | undefined}
   */
  static getKey(obj, val) {
    return Object.keys(obj).find(key => obj[key] === val);
  }

  /**
   * Returns a function, that, as long as it continues to be invoked, will not
   * be triggered. The function will be called after it stops being called for
   * N milliseconds.
   * @param fn
   * @param wait
   * @returns {Function}
   */
  static debounce(fn, wait = 0) {
    let timer = null;
    let resolves = [];

    return function (...args) {
      // Run the function after a certain amount of time
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Get the result of the inner function, then apply it to the resolve function of
        // each promise that has been created since the last time the inner function was run
        let result = fn(...args);
        resolves.forEach(r => r(result));
        resolves = [];
      }, wait);

      return new Promise(r => resolves.push(r));
    };
  }

  /**
   * Migrates OAuth access token from 2.0.x to 2.1.x
   * TODO: can be removed after 2.1.x has been pushed to stable.
   * @returns {{sessionId: *, configId: *, token: *}}
   */
  onOAuth2Migrate() {
    this.log('onOAuth2Migrate()');
    const oauth2AccountStore = this.getStoreValue('oauth2Account');

    if (!oauth2AccountStore)
      throw new Error('Missing OAuth2 Account');
    if (!oauth2AccountStore.accessToken)
      throw new Error('Missing Access Token');
    if (!oauth2AccountStore.refreshToken)
      throw new Error('Missing Refresh Token');

    const token = new OAuth2Token({
      access_token: oauth2AccountStore.accessToken,
      refresh_token: oauth2AccountStore.refreshToken,
    });

    const sessionId = OAuth2Util.getRandomId();
    const configId = this.getDriver().getOAuth2ConfigId();
    this.log('onOAuth2Migrate() -> migration succeeded', {
      sessionId,
      configId,
      token,
    });

    return {
      sessionId,
      configId,
      token,
    }
  }

  /**
   * When migration from 2.0.x to 2.1.x succeeded unset legacy store value.
   * @returns {Promise<void>}
   */
  async onOAuth2MigrateSuccess() {
    await this.unsetStoreValue('oauth2Account');
  }
}

module.exports = ToonDevice;
