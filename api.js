'use strict';

const Homey = require('homey');
const { OAuth2Util } = require('homey-oauth2app');


module.exports = [
	{
		description: 'Get logged in state',
		method: 'GET',
		path: '/login/',
		fn: (args, callback) => {
			if (Homey.app && typeof Homey.app.getSavedOAuth2Sessions === 'function') {
				let sessions = null;
				try {
					sessions = Homey.app.getSavedOAuth2Sessions();
				} catch (err) {
					console.error('getSavedOAuth2Sessions() -> error', err.message);
					return callback(err);
				}
				if (Object.keys(sessions).length > 1) {
					const err = new Error('Multiple OAuth2 sessions found, not allowed.');
					callback(err);
					throw err;
				}
				if (Object.keys(sessions).length > 0) return callback(null, true);
				if (Object.keys(sessions).length === 0) return callback(null, false);
			}
			return callback(new Error('Could not get current OAuth2 session'));
		},
	},
	{
		description: 'Set logged in state',
		method: 'POST',
		path: '/login/',
		fn: (args, callback) => {
			const loginState = args.body.state;

			if (loginState === true) { // login

				// Try get first saved client
				let client;
				try {
					client = Homey.app.getFirstSavedOAuth2Client();
				} catch (err) {
					console.error('Could not get first saved OAuth2 client', err);
				}

				// Create new client since first saved was not found
				if (!client || client instanceof Error) {
					console.log('Creating new OAuth2 client');
					client = Homey.app.createOAuth2Client({
						sessionId: OAuth2Util.getRandomId(),
					});
				}

				// Start OAuth2 process
				return new Homey.CloudOAuth2Callback(client.getAuthorizationUrl())
					.on('url', url => Homey.ManagerApi.realtime('url', url))
					.on('code', code => {
						client.getTokenByCode({ code })
							.then(async () => {
								// get the client's session info
								const session = await client.onGetOAuth2SessionInformation();
								const token = client.getToken();
								const title = session.title;
								client.destroy();

								// replace the temporary client by the final one and save it
								client = Homey.app.createOAuth2Client({
									sessionId: session.id,
								});
								client.setTitle({ title });
								client.setToken({ token });
								client.save();

								Homey.ManagerApi.realtime('authorized');

								// Get Toon devices
								const toonDevices = Homey.ManagerDrivers.getDriver('toon').getDevices();
								toonDevices.forEach(toonDevice => {

									// Call resetOAuth2Client on device to re-bind a new OAuth2Client instance to the device
									toonDevice.resetOAuth2Client({
										sessionId: session.id,
										configId: Homey.ManagerDrivers.getDriver('toon').getOAuth2ConfigId(),
									}).catch(console.error);
								});
							})
							.catch(err => {
								console.error('error', err.message || err.toString());
								Homey.ManagerApi.realtime('error', err);
							});
					})
					.generate();

			} else if (loginState === false) { // logout
				if (Homey.app && typeof Homey.app.getSavedOAuth2Sessions === 'function') {
					let sessions = null;

					// Get OAuth2 sessions
					try {
						sessions = Homey.app.getSavedOAuth2Sessions();
					} catch (err) {
						console.error('getSavedOAuth2Sessions() -> error', err.message);
						return callback(err);
					}

					// Loop all sessions and deleted the related clients
					for (const [sessionId, session] of Object.entries(sessions)) {
						console.log(`Delete client based on session (sessionId: ${sessionId}, configId: ${session.configId})`);
						try {
							Homey.app.deleteOAuth2Client({ sessionId, configId: session.configId });
						} catch (err) {
							console.error('could not delete OAuth2Client', err);
						}
					}

					// Get Toon devices
					const toonDevices = Homey.ManagerDrivers.getDriver('toon').getDevices();

					// Mark all Toon devices is unavailable
					toonDevices.forEach(toonDevice => toonDevice.setUnavailable(Homey.__('re-authorize')));
					return callback(null, true);
				}
				return callback(new Error('Could not get current OAuth2 session'));
			}
			throw new Error(`Invalid login state received ${loginState}`);
		},
	},
];
