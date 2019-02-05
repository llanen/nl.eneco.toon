'use strict';

const Homey = require('homey');
const { OAuth2Device, OAuth2Token, OAuth2Util } = require('homey-oauth2app');

const TEMPERATURE_STATES = {
  comfort: 0,
  home: 1,
  sleep: 2,
  away: 3,
  none: -1
};

class ToonDevice extends OAuth2Device {

  async onOAuth2Init() {
    this.log('onOAuth2Init()');

    // Indicate Homey is connecting to Toon
    await this.setUnavailable(Homey.__('connecting'));

    // Store raw data
    this.gasUsage = {};
    this.powerUsage = {};
    this.thermostatInfo = {};

    // Register capability listeners
    this.registerCapabilityListener('temperature_state', ToonDevice.debounce(this.onCapabilityTemperatureState.bind(this), 500));
    this.registerCapabilityListener('target_temperature', ToonDevice.debounce(this.onCapabilityTargetTemperature.bind(this), 500));

    // Register and start listening for webhooks
    await this.registerWebhook();
    await this.registerWebhookSubscription();

    // Fetch initial data
    await this.getStatusUpdate();
    await this.setAvailable();
    this.log('onOAuth2Init() -> success');

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
   * Method that will register a Homey webhook which listens for incoming events related to this specific device.
   */
  registerWebhook() {
    const debouncedMessageHandler = this._processStatusUpdate.bind(this);
    return new Homey.CloudWebhook(Homey.env.WEBHOOK_ID, Homey.env.WEBHOOK_SECRET, {
      displayCommonName: this.getData().id,
    })
      .on('message', debouncedMessageHandler)
      .register()
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

    // Start new subscription
    await this.oAuth2Client.registerWebhookSubscription({ id: this.id });
  }

  /**
   * This method will retrieve temperature, gas and electricity data from the Toon API.
   * @returns {Promise}
   */
  async getStatusUpdate() {
    try {
      const data = await this.oAuth2Client.getStatus({ id: this.id });
      this._processStatusUpdate({ body: { updateDataSet: data } });
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

    this.log(`updateState() -> set state to ${stateId} (${state}), data: {activeState: ${stateId}}`);

    try {
      await this.oAuth2Client.updateState({ id: this.id, data });
    } catch (err) {
      this.error(`updateState() -> error, failed to set temperature state to ${state} (${stateId})`, err.stack);
      throw err;
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
      return Promise.reject(new Error('missing_temperature_argument'));
    }

    this.setCapabilityValue('target_temperature', temperature).catch(this.error);

    return this.oAuth2Client.updateState({ id: this.id, data })
      .then(() => {
        this.log(`setTargetTemperature() -> success setting temperature to ${temperature}`);
        return temperature;
      }).catch(err => {
        this.error(`setTargetTemperature() -> error, failed to set temperature to ${temperature}`, err.stack);
        throw err;
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
        throw err;
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
        throw err;
      });
  }

  /**
   * Method that handles processing an incoming status update, whether it is from a GET /status request or a webhook
   * update.
   * @param data
   * @private
   */
  _processStatusUpdate(data) {
    this.log('_processStatusUpdate', new Date().getTime());

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
      this.setCapabilityValue('temperature_state', ToonDevice.getKey(TEMPERATURE_STATES, data.activeState)).catch(this.error);
    }
  }

  /**
   * This method will be called when the device has been deleted, it makes
   * sure the client is properly destroyed and left over settings are removed.
   */
  async onOAuth2Deleted() {
    this.log('onOAuth2Deleted()');
    await this.oAuth2Client.unregisterWebhookSubscription({ id: this.id });
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
   * N milliseconds. If `immediate` is passed, trigger the function on the
   * leading edge, instead of the trailing.
   * @param func
   * @param wait
   * @param immediate
   * @returns {Function}
   */
  static debounce(func, wait, immediate) {
    let timeout;
    return function () {
      let context = this, args = arguments;
      let later = function () {
        timeout = null;
        if (!immediate) func.apply(context, args);
      };
      let callNow = immediate && !timeout;
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
      if (callNow) func.apply(context, args);
    };
  };

  /**
   * Migrates OAuth access token from 2.0.x to 2.1.x
   * TODO: can be removed after 2.1.x has been pushed to stable.
   * @returns {{sessionId: *, configId: *, token: *}}
   */
  onOAuth2Migrate() {
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
