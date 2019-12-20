'use strict';

const async = require('async');

class Util {
  /**
   * Method that applies an exponential back-off retry strategy to the provided async function.
   * @param {AsyncFunction} method
   * @param {Number} [times=5]
   * @param {Function} [interval]
   * @returns {Promise<unknown>}
   * @private
   */
  static async exponentialBackOffRetry(
    method,
    times = 5,
    interval = function (retryCount) { return 6000 * Math.pow(2, retryCount) } ) {
    return new Promise((resolve, reject) => {
      async.retry({
        times,
        interval
      }, method, (err, result) => {
        if (err) return reject(err);
        return resolve(result);
      });
    });
  }
}

module.exports = Util;