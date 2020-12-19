const cacheFile = '/tmp/vatsim-data-cache';
const cacheLife = 60 * 60 * 3; // 3 hours
const statusUrl = 'https://status.vatsim.net/';

const dataServerBlacklist = [];

const cache = require('node-file-cache').create({ file: cacheFile, life: cacheLife });
const request = require('request');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const zlib = require('zlib');

let dataTimestamp = null;

function getDataServer() {
    return new Promise(function(resolve, reject) {
        getDataServers().then(function (servers) {
            resolve(servers[Math.floor(Math.random() * servers.length)]);
        });
    });
}

function getDataServers() {
    return new Promise(function(resolve, reject) {
        let cachedServers = cache.get('vatsim-data-servers');

        if (cachedServers) {
            resolve(cachedServers);
        } else {
            getFreshDataServers().then(function (servers) {
                resolve(servers);
            });
        }
    });
}

function getFreshDataServers() {
    return new Promise(function(resolve, reject) {
        let servers = [];
        request(statusUrl, function(error, response, body) {
            if (!error) {
                const lines = body.replace(/\r/g, '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].substring(0, 5) === 'url0=') {
                        let server = lines[i].substring(5);
                        if (dataServerBlacklist.indexOf(server) === -1) {
                            servers.push(lines[i].substring(5));
                        }
                    }
                }

                cache.set('vatsim-data-servers', servers);

                resolve(servers);
            } else {
                reject(error);
            }
        });
    });
}

function getData(url) {
    return new Promise(function (resolve, reject) {
        request(url, function(error, response, body) {
            if (!error) {
                // strip comments from the file
                let timestampMatch = body.match(/!GENERAL:[^!]*UPDATE = ([\d]*)/);
                if (timestampMatch) {
                    dataTimestamp = timestampMatch[1];
                    resolve(body.replace(/^;[^\n]*\n/gm, ''));
                } else {
                    reject(Error('Data timestamp not valid: ' + dataTimestamp))
                }
            } else {
                reject(error);
            }
        });
    });
}

function compressData(data) {
    return new Promise(function (resolve, reject) {
        zlib.gzip(data, (err, buffer) => {
            if (err) {
                reject(Error('Error gzipping data.'))
            }

            resolve(buffer)
        });
    });
}

module.exports.store = (event, context, callback) => {
    getDataServer()
        .then(getData)
        .then(compressData)
        .then(function uploadToS3(data) {
            const date = new Date()
            return s3.upload({
                Bucket: process.env.BUCKET,
                Key: date.getUTCFullYear() + '/'
                    + date.getUTCMonth() + '/'
                    + date.getUTCDay() + '/'
                    + date.getUTCHours() + '/'
                    + dataTimestamp + '.txt.gz',
                Body: data,
                ServerSideEncryption: 'AES256',
            }).promise();
        })
        .then(success => callback(null, success))
        .catch(callback);
};
