// index.js (수정본)
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const { sendSMS } = require('./smsNcloud'); // 네이버클라우드 SMS 모듈

const app = express();
app.use(express.json());

// CORS 설정
app.use(cors({
  origin: [
    'https://credit-namecheck.netlify.app',
    'https://credit-namecheck.netlify.app/'
  ]
}));

// In‑memory 저장소
// key = merchant_uid, value = { requesterPhone, recvPhone, verifyStatus, updatedAt }
const store = new Map();

// PortOne 토큰 함수
async function getPortoneToken() {
  const { data } = await axios.post(
    'https://api.iamport.kr/users/getToken',
    {
      imp_key   : process.env.IMP_KEY,
      imp_secret: process.env.IMP_SECRET
    }
  );
  return data.response.access_token;
}

// 모바일 위·변조 해시 생성 (선택)
function makeMobileHash({ mid, oid, price, timestamp }) {
  const msg = `${mid}${oid}${price}${timestamp}`;
  return crypto
    .createHmac('sha256', process.env.MOBILE_HASHKEY)
    .update(msg)
    .digest('hex');
}

// 1) 결제 완료 → 요청 생성
app.post('/api/createRequest', async (req, res) => {
  const { imp_uid, merchant_uid, phone: requesterPhone } = req.body;
  try {
    // 결제 검증
    const token = await getPortoneToken();
    const { data } = await axios.get(
      `https://api.iamport.kr/payments/${imp_uid}`,
      { headers: { Authorization: token } }
    );
    const { status, amount } = data.response;
    if (status !== 'paid' || amount !== 1000) {
      return res.status(400).json({ success: false, error: '결제 검증 실패' });
    }

    // 요청 저장
    store.set(merchant_uid, {
      requesterPhone,
      recvPhone    : null,
      verifyStatus : 'pending',
      updatedAt    : Date.now()
    });

    // 상대방에게 본인인증 링크 전송
    const link = `https://credit-namecheck.netlify.app/namecheck.html?id=${merchant_uid}`;
    await sendSMS(requesterPhone, `[크레디톡] 본인인증 요청\n${link}`);

    console.log('[createRequest] 완료 →', merchant_uid);
    res.json({ success: true });
  } catch (err) {
    console.error('[createRequest] ', err.response?.data || err.message);
    res.status(500).json({ success: false, error: '서버 내부 오류' });
  }
});

// 2) 수신자 전화번호 저장 (수정: payload 로그 추가)
app.post('/api/saveReceiver', (req, res) => {
  console.log('[saveReceiver] payload=', req.body);
  const { merchant_uid, recv_phone: recvPhone } = req.body;
  const record = store.get(merchant_uid);

  if (!record) {
    return res.status(404).json({ success: false, error: '요청 없음' });
  }
  record.recvPhone = recvPhone;
  record.updatedAt = Date.now();
  console.log('[saveReceiver] 저장 →', merchant_uid, recvPhone);
  res.json({ success: true });
});

// 3) 본인인증 결과 처리 (수정: 진입 로그 추가)
app.post('/api/verifyResult', async (req, res) => {
  console.log('[verifyResult] 호출됨, payload=', req.body);
  const { merchant_uid, result } = req.body;
  const record = store.get(merchant_uid);

  if (!record || !record.recvPhone) {
    console.error('[verifyResult] ❗ recvPhone 누락');
    return res.status(404).json({ success: false, error: '수신 번호 미등록' });
  }
  if (record.verifyStatus !== 'pending') {
    return res.status(409).json({ success: false, error: '이미 처리됨' });
  }

  record.verifyStatus = result;
  record.updatedAt    = Date.now();

  const msg = result === 'success'
    ? '[크레디톡] 상대방이 본인인증에 성공했습니다.'
    : '[크레디톡] 상대방이 본인인증에 실패했습니다. 거래에 유의하세요.';

  try {
    await sendSMS(record.recvPhone, msg);
    console.log('[verifyResult] SMS 발송 →', merchant_uid, result);
    res.json({ success: true });
  } catch (e) {
    console.error('[verifyResult] 에러 →', e.response?.data || e.message);
    res.status(500).json({ success: false, error: 'SMS 전송 실패' });
  }
});

// 헬스 체크
app.get('/', (_req, res) => res.send('Hello Backend!'));

// 서버 시작
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 서버 실행 중: ${PORT}`));
