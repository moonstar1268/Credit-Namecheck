// smsNcloud.js
const axios    = require('axios');
const CryptoJS = require('crypto-js');
require('dotenv').config();

const sens_serviceId = process.env.NCLOUD_SMS_SERVICE_ID;
const sens_accessKey = process.env.NCLOUD_ACCESS_KEY;
const sens_secretKey = process.env.NCLOUD_SECRET_KEY;
const sens_caller    = process.env.NCLOUD_SMS_CALLER;

function byteLen(s){ return Buffer.byteLength(String(s ?? ''), 'utf8'); }

async function sendSMS(to, content) {
  const date = Date.now().toString();
  const method = 'POST';
  const uri = `/sms/v2/services/${sens_serviceId}/messages`;
  const url = `https://sens.apigw.ntruss.com${uri}`;

  const isLms = byteLen(content) > 90; // 90B 초과 시 LMS로 전송
  const body = isLms
    ? { type:'LMS', from:sens_caller, subject:'크레디톡 알림', content, messages:[{ to }] }
    : { type:'SMS', from:sens_caller, content, messages:[{ to }] };

  const headers = {
    'Content-Type'            : 'application/json; charset=utf-8',
    'x-ncp-apigw-timestamp'   : date,
    'x-ncp-iam-access-key'    : sens_accessKey,
    'x-ncp-apigw-signature-v2': makeSignature(date, method, uri)
  };

  const res = await axios.post(url, body, { headers });
  return res.data;
}

function makeSignature(timestamp, method, uri) {
  const hmac = CryptoJS.algo.HMAC.create(CryptoJS.algo.SHA256, sens_secretKey);
  hmac.update(method);
  hmac.update(' ');
  hmac.update(uri);
  hmac.update('\n');
  hmac.update(timestamp);
  hmac.update('\n');
  hmac.update(sens_accessKey);
  return hmac.finalize().toString(CryptoJS.enc.Base64);
}

module.exports = { sendSMS };
