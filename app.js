'use strict';

const Homey = require('homey');
const Log = require('homey-log').Log;
const { OAuth2App, OAuth2Util } = require('homey-oauth2app');

const ToonOAuth2Client = require('./lib/ToonOAuth2Client');

const TOON_DRIVER_NAME = 'toon';

class ToonApp extends OAuth2App {

	onOAuth2Init() {
		this.enableOAuth2Debug();
		this.setOAuth2Config({
			client: ToonOAuth2Client,
			clientId: Homey.env.TOON_KEY,
			clientSecret: Homey.env.TOON_SECRET,
			apiUrl: 'https://api.toon.eu/toon/v3/',
			tokenUrl: 'https://api.toon.eu/token',
			authorizationUrl: 'https://api.toon.eu/authorize',
		});

		this.log(`${this.id} running...`);
	}

	get ToonDriver() {
		return Homey.ManagerDrivers.getDriver(TOON_DRIVER_NAME);
	}

	async isAuthenticated() {
		try {
			const session = await this._getSession();
			this.log(`isAuthenticated() -> ${!!session}`);
			return !!session;
		} catch (err) {
			this.error('isAuthenticated() -> could not get current session:', err);
			throw new Error('Could not get current OAuth2 session');
		}
	}

	async login() {
		this.log('login()');

		// Try get first saved client
		let client;
		try {
			client = this.getFirstSavedOAuth2Client();
		} catch (err) {
			this.log('login() -> no existing OAuth2 client available');
		}

		// Create new client since first saved was not found
		if (!client || client instanceof Error) {
			client = this.createOAuth2Client({ sessionId: OAuth2Util.getRandomId() });
		}

		this.log('login() -> created new temporary OAuth2 client');

		// Start OAuth2 process
		return new Homey.CloudOAuth2Callback(client.getAuthorizationUrl())
			.on('url', url => Homey.ManagerApi.realtime('url', url))
			.on('code', async code => {
				this.log('login() -> received OAuth2 code');
				try {
					await client.getTokenByCode({ code });
				} catch (err) {
					this.error('login() -> could not get token by code', err);
					Homey.ManagerApi.realtime('error', new Error(Homey.__('authentication.re-login_failed_with_error', { error: err.message || err.toString() })));
				}
				// get the client's session info
				const session = await client.onGetOAuth2SessionInformation();
				const token = client.getToken();
				const title = session.title;
				client.destroy();

				try {
					// replace the temporary client by the final one and save it
					client = this.createOAuth2Client({ sessionId: session.id });
					client.setTitle({ title });
					client.setToken({ token });
					client.save();
				} catch (err) {
					this.error('Could not create new OAuth2 client', err);
					Homey.ManagerApi.realtime('error', new Error(Homey.__('authentication.re-login_failed_with_error', { error: err.message || err.toString() })));
				}

				this.log('login() -> authenticated');
				Homey.ManagerApi.realtime('authorized');

				// Get Toon devices and call resetOAuth2Client on device to re-bind a new OAuth2Client
				// instance to the device
				try {
					await this.ToonDriver
						.getDevices()
						.forEach(toonDevice => toonDevice.resetOAuth2Client({
							sessionId: session.id,
							configId: this.ToonDriver.getOAuth2ConfigId(),
						}));
				} catch (err) {
					this.error('Could not reset OAuth2 client on Toon device instance', err);
					Homey.ManagerApi.realtime('error', new Error(Homey.__('authentication.re-login_failed_with_error', { error: err.message || err.toString() })));
				}
				this.log('login() -> reset devices to new OAuth2 client');
			})
			.generate();
	}

	async logout() {
		this.log('logout()');
		const session = await this._getSession();
		const sessionId = Object.keys(session)[0];
		this.deleteOAuth2Client({ sessionId, configId: session.configId });

		// Get Toon devices and mark as unavailable
		return Promise.all(
			this.ToonDriver
				.getDevices()
				.map(toonDevice => toonDevice.setUnavailable(Homey.__('authentication.re-authorize')))
		);
	}

	async _getSession() {
		let sessions = null;
		try {
			sessions = this.getSavedOAuth2Sessions();
		} catch (err) {
			this.error('isAuthenticated() -> error', err.message);
			throw err;
		}
		if (Object.keys(sessions).length > 1) {
			throw new Error('Multiple OAuth2 sessions found, not allowed.');
		}
		this.log('_getSession() ->', Object.keys(sessions).length === 1 ? Object.keys(sessions)[0] : 'no session found');
		return Object.keys(sessions).length === 1 ? sessions : null;
	}
}

module.exports = ToonApp;
