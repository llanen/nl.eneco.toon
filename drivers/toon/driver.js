'use strict';

const Homey = require('homey');

const ToonDevice = require('./device.js');
const OAuth2Driver = require('homey-wifidriver').OAuth2Driver;

const oauth2ClientConfig = {
	url: `https://api.toon.eu/authorize?response_type=code&redirect_uri=https://callback.athom.com/oauth2/callback/&client_id=${Homey.env.TOON_KEY_V3}&tenant_id=eneco`,
	tokenEndpoint: 'https://api.toon.eu/token',
	key: Homey.env.TOON_KEY_V3,
	secret: Homey.env.TOON_SECRET_V3,
	allowMultipleAccounts: false,
};

const API_BASE_URL = 'https://api.toon.eu/toon/v3/';

class ToonDriver extends OAuth2Driver {

	/**
	 * This method will be called when the driver initializes, it initializes Flow Cards.
	 */
	onInit() {

		// Start OAuth2Client
		super.onInit({
			oauth2ClientConfig,
		});

		new Homey.FlowCardCondition('temperature_state_is')
			.register()
			.registerRunListener(args =>
				Promise.resolve(args.device.getCapabilityValue('temperature_state') === args.state));

		new Homey.FlowCardAction('set_temperature_state')
			.register()
			.registerRunListener(args =>
				args.device.onCapabilityTemperatureState(args.state, (args.resume_program === 'yes')));

		new Homey.FlowCardAction('enable_program')
			.register()
			.registerRunListener(args => args.device.enableProgram());

		new Homey.FlowCardAction('disable_program')
			.register()
			.registerRunListener(args => args.device.disableProgram());

		this.log('onInit() -> complete, Flow Cards registered');
	}

	/**
	 * The method will be called during pairing when a list of devices is needed. Only when this class
	 * extends WifiDriver and provides a oauth2ClientConfig onInit. The data parameter contains an
	 * temporary OAuth2 account that can be used to fetch the devices from the users account.
	 * @returns {Promise}
	 */
	onPairOAuth2ListDevices() {
		return this.apiCallGet({ uri: 'https://api.toon.eu/toon/v3/agreements' })
			.then(agreements => {
				this.log(`got ${agreements.length} agreements`);
				if (Array.isArray(agreements)) {
					return agreements.map(agreement => ({
						name: (agreements.length > 1) ? `Toon®: ${agreement.street} 
												${agreement.houseNumber} , ${agreement.postalCode} 
												${agreement.city.charAt(0)}${agreement.city.slice(1).toLowerCase()}` : 'Toon®',
						data: {
							id: agreement.displayCommonName,
							agreementId: agreement.agreementId,
						},
					}));
				}
				return [];
			})
			.catch(err => {
				this.error('failed to get agreements', err.stack);
				throw err;
			});
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
