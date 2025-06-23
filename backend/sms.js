const twilio = require('twilio');
require('dotenv').config(); // ← 이걸 추가!

// .env에서 환경변수를 가져와서 설정
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function sendSMS(to, body) {
    return client.messages.create({
        body,
        from: process.env.TWILIO_FROM,  // .env에서 발신번호 읽기
        to
    });
}

module.exports = { sendSMS };
