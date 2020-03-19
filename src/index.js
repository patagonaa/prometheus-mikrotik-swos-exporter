const urllib = require('urllib');
var express = require('express')
var app = express();

function fixBrokenJson(brokenJson) {
    return brokenJson
        .replace(/([{,])([a-zA-Z][a-zA-Z0-9]+)/g, '$1"$2"') // {abc: 123} -> {"abc": 123}
        .replace(/'/g, '"') // ' -> "
        .replace(/(0x[0-9a-zA-Z]+)/g, '"$1"'); // 0x1234 -> "0x1234"
}

function parseBrokenJson(brokenJson) {
    return JSON.parse(fixBrokenJson(brokenJson));
}

function parseHexInt16(hex) {
    let result = parseInt(hex, 16);
    if ((result & 0x8000) !== 0) {
        result -= 0x10000;
    }
    return result;
}

function parseHexInt32(hex) {
    let result = parseInt(hex, 16);
    if ((result & 0x80000000) !== 0) {
        result -= 0x100000000;
    }
    return result;
}

async function doRequest(target, endPoint, user, password) {
    let requestOptions = {
        digestAuth: `${user}:${password}`,
        dataType: 'text'
    };

    let url = `http://${target}/${endPoint}`;

    return await new Promise((resolve, reject) => {
        urllib.request(url, requestOptions, (err, data, res) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(data);
        });
    });
}

async function getSfp(target, user, password) {
    let sfp = await doRequest(target, 'sfp.b', user, password);
    return parseBrokenJson(sfp.toString());
}

async function getSystem(target, user, password) {
    let sys = await doRequest(target, 'sys.b', user, password);
    return parseBrokenJson(sys.toString());
}

const client = require('prom-client');

const sfpTempGauge = new client.Gauge({
    name: 'swos_sfp_temperature_celsius',
    help: 'Temperature of SFP Module',
    labelNames: ['sfp_name']
});
const sfpVccGauge = new client.Gauge({
    name: 'swos_sfp_vcc_volts',
    help: 'VCC voltage of SFP Module',
    labelNames: ['sfp_name']
});
const sfpTxBiasGauge = new client.Gauge({
    name: 'swos_sfp_tx_bias_milliamps',
    help: 'TX Bias (mA) of SFP Module',
    labelNames: ['sfp_name']
});
const sfpTxPowerGauge = new client.Gauge({
    name: 'swos_sfp_tx_power_milliwatts',
    help: 'TX Power (mW) of SFP Module',
    labelNames: ['sfp_name']
});
const sfpRxPowerGauge = new client.Gauge({
    name: 'swos_sfp_rx_power_milliwatts',
    help: 'RX Power (mW) of SFP Module',
    labelNames: ['sfp_name']
});
const deviceTemperatureGauge = new client.Gauge({
    name: 'swos_device_temperature',
    help: 'Temperature of SwOS Device'
});

async function getMetrics(target, user, password) {
    client.register.resetMetrics();

    let sfpData = await getSfp(target, user, password);
    let sfpCount = sfpData.vnd.length;

    for (let i = 0; i < sfpCount; i++) {
        if (sfpData.vnd[i] == '')
            continue;

        let labels = { sfp_name: `SFP${i+1}` };
        let temperature = parseHexInt32(sfpData.tmp[i]);
        if (temperature != -128)
            sfpTempGauge.set(labels, temperature);

        let voltage = parseHexInt16(sfpData.vcc[i]);
        if (voltage != 0)
            sfpVccGauge.set(labels, voltage / 1000);

        let txBias = parseHexInt16(sfpData.tbs[i]);
        if (txBias != 0)
            sfpTxBiasGauge.set(labels, txBias);

        let txPowerMilliwatts = parseHexInt16(sfpData.tpw[i]);
        if (txPowerMilliwatts != 0)
            sfpTxPowerGauge.set(labels, txPowerMilliwatts / 10000);

        let rxPowerMilliwatts = parseHexInt16(sfpData.rpw[i]);
        if (rxPowerMilliwatts != 0)
            sfpRxPowerGauge.set(labels, rxPowerMilliwatts / 10000);
    }

    let sysData = await getSystem(target, user, password);
    deviceTemperatureGauge.set({}, parseHexInt32(sysData.temp));
}

app.get('/metrics', async function (req, res, next) {
    try {
        console.info('scraping', req.query.target);
        await getMetrics(req.query.target, req.query.user || 'admin', req.query.password || '');
        res.end(client.register.metrics());
    } catch (e) {
        console.error(e);
        next(e);
    }
});

app.listen(3000, function () {
    console.log('Exporter listening on port 3000!')
});