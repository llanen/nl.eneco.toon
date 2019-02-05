'use strict';

const Homey = require('homey');
const Log = require('homey-log').Log;
const { OAuth2App } = require('homey-oauth2app');

const ToonOAuth2Client = require('./lib/ToonOAuth2Client');

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
}

module.exports = ToonApp;
