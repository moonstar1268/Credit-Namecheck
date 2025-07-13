const express = require('express');
const axios    = require('axios');
const cors     = require('cors');
const { sendSMS } = require('./smsNcloud');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use(cors({
  origin: 'https://credit-namecheck.netlify.app'
}));

/* ----------------------- PortOne 토큰 ----------------------- */
async function getPortoneAccessToken() {
  const { data } = await axios.post('https://api.iamport.kr/users/getToken', {
    imp_key   : process.env.IMP_KEY,
    imp_secret: process.env.IMP_SECRET
  });
  return data.response.access_token;
}

/* ----------------------- 결제 검증 + SMS 발송 ----------------------- */
app.post('/api/createRequest', async (req, res) => {
  const { imp_uid, merchant_uid, phone } = req.body;

  try {
    const token = await getPortoneAccessToken();
    const { data: paymentData } = await axios.get(
      `https://api.iamport.kr/payments/${imp_uid}`,
      { headers: { Authorization: token } }
    );

    const { status, amount } = paymentData.response;

    if (status === 'paid' && amount === 1000) {
      const message =
        `안녕하세요, 크레디톡입니다.\n본인인증 요청이 도착했습니다.\n아래 링크에서 진행해주세요:\nhttps://examplelink.com/${merchant_uid}`;

      await sendSMS(phone, message);
      console.log('SMS 요청 성공:', phone);
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: '결제 검증 실패' });
    }
  } catch (error) {
    console.error('SMS 전송 또는 결제 검증 오류:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: '서버 내부 오류 발생' });
  }
});

/* ----------------------- 건강 체크 ----------------------- */
app.get('/', (_req, res) => res.send('Hello Backend!'));

/* ----------------------- 서버 시작 ----------------------- */
const PORT = process.env.PORT || 4000;   // Render 에선 env.PORT 자동 주입
app.listen(PORT, () => console.log(`서버가 ${PORT}포트에서 작동중입니다.`));
