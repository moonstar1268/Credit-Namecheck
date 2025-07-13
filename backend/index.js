/* ---------- 기본 설정 ---------- */
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const { sendSMS } = require('./smsNcloud');
require('dotenv').config();

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: 'https://credit-namecheck.netlify.app',
  })
);

/* ---------- in-memory 저장소 ---------- */
/* key = merchant_uid, value = { requester_phone, recv_phone?, verify_status } */
const store = new Map();

/* ---------- PortOne 토큰 ---------- */
async function getPortoneAccessToken() {
  const { data } = await axios.post(
    'https://api.iamport.kr/users/getToken',
    {
      imp_key: process.env.IMP_KEY,
      imp_secret: process.env.IMP_SECRET,
    }
  );
  return data.response.access_token;
}

/* ────────────────────────────────────────────────
   1) 결제 완료 콜백 → SMS 발송 & store 초기화
   ------------------------------------------------ */
app.post('/api/createRequest', async (req, res) => {
  const { imp_uid, merchant_uid, phone: requester_phone } = req.body;

  try {
    const token = await getPortoneAccessToken();
    const { data: paymentData } = await axios.get(
      `https://api.iamport.kr/payments/${imp_uid}`,
      { headers: { Authorization: token } }
    );

    const { status, amount } = paymentData.response;

    if (status === 'paid' && amount === 1000) {
      /* 저장소에 요청 초기화 */
      store.set(merchant_uid, {
        requester_phone,
        recv_phone: null,
        verify_status: 'pending',
      });

      /* 상대방에게 본인인증 링크 발송 */
      const link = `https://credit-namecheck.netlify.app/namecheck.html?id=${merchant_uid}`;
      await sendSMS(
        requester_phone,
        `[본인인증]:\n${link}`
      );

      console.log('createRequest 완료:', merchant_uid);
      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: '결제 검증 실패' });
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, error: '서버 내부 오류' });
  }
});

/* ────────────────────────────────────────────────
   2) complete.html → 결과 수신 번호 저장
   ------------------------------------------------ */
app.post('/api/saveReceiver', (req, res) => {
  const { merchant_uid, recv_phone } = req.body;

  const record = store.get(merchant_uid);
  if (!record)
    return res.status(404).json({ success: false, error: '요청을 찾을 수 없음' });

  record.recv_phone = recv_phone;
  record.updated_at = Date.now();
  console.log('recv_phone 저장:', merchant_uid, recv_phone);
  res.json({ success: true });
});

/* ────────────────────────────────────────────────
   3) verify.html → 본인인증 결과 보고
   ------------------------------------------------ */
app.post('/api/verifyResult', async (req, res) => {
  const { merchant_uid, result } = req.body; // result: 'success' | 'fail'

  const record = store.get(merchant_uid);
  if (!record || !record.recv_phone)
    return res
      .status(404)
      .json({ success: false, error: '수신 번호가 등록되지 않음' });

  if (record.verify_status !== 'pending')
    return res
      .status(409)
      .json({ success: false, error: '이미 처리된 요청' });

  record.verify_status = result;
  record.updated_at = Date.now();

  const msg =
    result === 'success'
      ? '[크레디톡] 상대방이 본인인증에 성공했습니다.'
      : '[크레디톡] 상대방이 본인인증에 실패했습니다. 거래에 유의하세요.';

  try {
    await sendSMS(record.recv_phone, msg);
    console.log('verifyResult SMS 전송:', merchant_uid, result);
    res.json({ success: true });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ success: false, error: 'SMS 전송 실패' });
  }
});

/* ---------- 헬스 체크 ---------- */
app.get('/', (_req, res) => res.send('Hello Backend!'));

/* ---------- 서버 시작 ---------- */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`서버가 ${PORT} 포트에서 작동중입니다.`));
