'use strict';

const Homey = require('homey');

const { OAuth2Driver } = require('homey-oauth2app');
const ToonDevice = require('./device.js');

class ToonDriver extends OAuth2Driver {

  onOAuth2Init() {
    this.log('onOAuth2Init()');
    super.onOAuth2Init();

    new Homey.FlowCardCondition('temperature_state_is')
      .register()
      .registerRunListener(args => Promise.resolve(args.device.getCapabilityValue('temperature_state') === args.state));

    new Homey.FlowCardAction('set_temperature_state')
      .register()
      .registerRunListener(args => args.device.onCapabilityTemperatureState(args.state, (args.resume_program === 'yes')));

    new Homey.FlowCardAction('enable_program')
      .register()
      .registerRunListener(args => args.device.enableProgram());

    new Homey.FlowCardAction('disable_program')
      .register()
      .registerRunListener(args => args.device.disableProgram());

    this.log('onOAuth2Init() -> success');
  }

  /**
   * The method will be called during pairing when a list of devices is needed. Only when this class
   * extends WifiDriver and provides a oauth2ClientConfig onInit. The data parameter contains an
   * temporary OAuth2 account that can be used to fetch the devices from the users account.
   * @returns {Promise}
   */
  async onPairListDevices({ oAuth2Client }) {
    this.log('onPairListDevices()');
    let agreements;
    try {
      agreements = await oAuth2Client.getAgreements();
    } catch (err) {
      this.error('onPairListDevices() -> error, failed to get agreements, reason:', err.message);
      throw new Error(Homey.__('pairing.agreement_error'));
    }
    this.log(`onPairListDevices() -> got ${agreements.length} agreements`);
    if (Array.isArray(agreements)) {
      return agreements.map(agreement => ({
        name: (agreements.length > 1) ? `Toon: ${agreement.street} ${agreement.houseNumber} , ${agreement.postalCode} ${agreement.city.charAt(0)}${agreement.city.slice(1).toLowerCase()}` : 'Toon',
        data: {
          id: agreement.displayCommonName,
          agreementId: agreement.agreementId,
        },
        store: {
          apiVersion: 3,
        },
      }));
    }
    return [];
  }

  /**
   * Always use ToonDevice as device for this driver.
   * @returns {ToonDevice}
   */
  mapDeviceClass() {
    return ToonDevice;
  }

}

module.exports = ToonDriver;
