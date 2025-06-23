const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { sendSMS } = require('./smsNcloud');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use(cors({
    origin: 'https://credit-namecheck.netlify.app'
}));

// 포트원 Access Token 가져오기
async function getPortoneAccessToken() {
    const { data } = await axios.post('https://api.iamport.kr/users/getToken', {
        imp_key: process.env.IMP_KEY,
        imp_secret: process.env.IMP_SECRET
    });
    return data.response.access_token;
}

// 결제 완료 후 인증 링크 SMS 발송 (네이버 클라우드 이용)
app.post('/api/createRequest', async (req, res) => {
    const { imp_uid, merchant_uid, phone } = req.body;

    try {
        const token = await getPortoneAccessToken();
        const { data: paymentData } = await axios.get(
            `https://api.iamport.kr/payments/${imp_uid}`, {
                headers: { Authorization: token }
            }
        );

        const { status, amount } = paymentData.response;

        if (status === 'paid' && amount === 1000) {
            const message =
                `안녕하세요, 크레디톡입니다. 본인인증 요청이 도착하였습니다. 다음 링크에서 진행해주세요:\nhttps://examplelink.com/${merchant_uid}`;

            await sendSMS(phone, message);
            res.json({ success: true });
        } else {
            res.status(400).json({ success: false, error: "결제 검증 실패" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "서버 내부 오류 발생" });
    }
});

// 기본 루트
app.get('/', (req, res) => res.send('Hello Backend!'));

// 서버 시작
app.listen(4000, () => console.log('서버가 4000포트에서 작동중입니다.'));
