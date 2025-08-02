// smsNcloud.js
const axios    = require('axios');
const CryptoJS = require('crypto-js');
require('dotenv').config();

/* --- 네이버 SENS 환경변수 --- */
const sens_serviceId = process.env.NCLOUD_SMS_SERVICE_ID;
const sens_accessKey = process.env.NCLOUD_ACCESS_KEY;
const sens_secretKey = process.env.NCLOUD_SECRET_KEY;
const sens_caller    = process.env.NCLOUD_SMS_CALLER;

/* --- 단문 SMS 전송 함수 --- */
async function sendSMS(to, content) {
  const date   = Date.now().toString();
  const method = 'POST';
  const uri    = `/sms/v2/services/${sens_serviceId}/messages`;
  const url    = `https://sens.apigw.ntruss.com${uri}`;

  // 1) 서명 생성 전 로그
  console.log('[sendSMS] 호출 →', { to, content, url, date });

  const signature = makeSignature(date, method, uri);

  const body = {
    type    : 'SMS',
    from    : sens_caller,
    content,
    messages: [{ to }]
  };

  const headers = {
    'Content-Type'           : 'application/json; charset=utf-8',
    'x-ncp-apigw-timestamp'  : date,
    'x-ncp-iam-access-key'   : sens_accessKey,
    'x-ncp-apigw-signature-v2': signature
  };

  try {
    // 2) 실제 API 호출
    const res = await axios.post(url, body, { headers });
    // 3) 성공 로그
    console.log('[sendSMS] 성공 응답 →', res.data);
    return res.data;
  } catch (e) {
    // 4) 에러 로그
    console.error('[sendSMS] 에러 →', e.response?.data || e.message);
    throw e;
  }
}

/* --- 시그니처 생성 --- */
function makeSignature(timestamp, method, uri) {
  console.log('[makeSignature] 시작 →', { timestamp, method, uri });

  const space   = ' ';
  const newLine = '\n';
  const hmac    = CryptoJS.algo.HMAC.create(CryptoJS.algo.SHA256, sens_secretKey);

  hmac.update(method);
  hmac.update(space);
  hmac.update(uri);
  hmac.update(newLine);
  hmac.update(timestamp);
  hmac.update(newLine);
  hmac.update(sens_accessKey);

  const sig = hmac.finalize().toString(CryptoJS.enc.Base64);
  console.log('[makeSignature] 완료 →', sig);
  return sig;
}

module.exports = { sendSMS };
