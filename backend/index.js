```js
// index.js (백틱 제거 버전)
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const { sendSMS } = require('./smsNcloud');

const app = express();
app.use(express.json());

// CORS 설정
app.use(cors({
  origin: [
    'https://credit-namecheck.netlify.app',
    'https://credit-namecheck.netlify.app/'
  ]
}));

// In-memory 저장소
const store = new Map();

// PortOne 토큰 함수
async function getPortoneToken() {
  const response = await axios.post(
    'https://api.iamport.kr/users/getToken',
    {
      imp_key: process.env.IMP_KEY,
      imp_secret: process.env.IMP_SECRET
    }
  );
  return response.data.response.access_token;
}

// 모바일 해시 생성 (선택)
function makeMobileHash(params) {
  const msg = '' + params.mid + params.oid + params.price + params.timestamp;
  return crypto
    .createHmac('sha256', process.env.MOBILE_HASHKEY)
    .update(msg)
    .digest('hex');
}

// 1. 결제 완료 → 요청 생성
app.post('/api/createRequest', async (req, res) => {
  const imp_uid = req.body.imp_uid;
  const merchant_uid = req.body.merchant_uid;
  const requesterPhone = req.body.phone;
  try {
    // 결제 검증
    const token = await getPortoneToken();
    const response = await axios.get(
      'https://api.iamport.kr/payments/' + imp_uid,
      { headers: { Authorization: token } }
    );
    const status = response.data.response.status;
    const amount = response.data.response.amount;
    if (status !== 'paid' || amount !== 1000) {
      return res.status(400).json({ success: false, error: '결제 검증 실패' });
    }

    // 요청 저장
    store.set(merchant_uid, {
      requesterPhone: requesterPhone,
      recvPhone: null,
      verifyStatus: 'pending',
      updatedAt: Date.now()
    });

    // 인증 링크 전송
    const link = 'https://credit-namecheck.netlify.app/namecheck.html?id=' + merchant_uid;
    await sendSMS(requesterPhone, '[크레디톡] 본인인증 요청\n' + link);

    console.log('[createRequest] 완료 →', merchant_uid);
    res.json({ success: true });
  } catch (err) {
    console.error('[createRequest] ', err.response?.data || err.message);
    res.status(500).json({ success: false, error: '서버 내부 오류' });
  }
});

// 2. 수신 번호 저장
app.post('/api/saveReceiver', (req, res) => {
  console.log('[saveReceiver] payload=', req.body);
  const merchant_uid = req.body.merchant_uid;
  const recvPhone = req.body.recv_phone;
  const record = store.get(merchant_uid);
  if (!record) {
    return res.status(404).json({ success: false, error: '요청 없음' });
  }
  record.recvPhone = recvPhone;
  record.updatedAt = Date.now();
  console.log('[saveReceiver] 저장 →', merchant_uid, recvPhone);
  res.json({ success: true });
});

// 3. 본인인증 결과 처리 (UID fallback 지원)
app.post('/api/verifyResult', async (req, res) => {
  console.log('[verifyResult] 호출됨, payload=', req.body);
  let merchant_uid = req.body.merchant_uid;
  const result = req.body.result;

  // 잘린 UID 매칭
  let fullUid = merchant_uid;
  if (!store.has(fullUid)) {
    const match = Array.from(store.keys()).find(k => k.indexOf(merchant_uid) === 0);
    if (match) {
      console.log('[verifyResult] 잘린 UID 감지, 재설정 →', match);
      fullUid = match;
    }
  }
  const record = store.get(fullUid);

  if (!record || !record.recvPhone) {
    console.error('[verifyResult] ❗ recvPhone 누락 (UID=', fullUid, ')');
    return res.status(404).json({ success: false, error: '수신 번호 미등록' });
  }
  if (record.verifyStatus !== 'pending') {
    return res.status(409).json({ success: false, error: '이미 처리됨' });
  }

  record.verifyStatus = result;
  record.updatedAt = Date.now();

  const msg = record.verifyStatus === 'success'
    ? '[크레디톡] 상대방이 본인인증에 성공했습니다.'
    : '[크레디톡] 상대방이 본인인증에 실패했습니다. 거래에 유의하세요.';
  try {
    await sendSMS(record.recvPhone, msg);
    console.log('[verifyResult] SMS 발송 →', fullUid, result);
    res.json({ success: true });
  } catch (e) {
    console.error('[verifyResult] 에러 →', e.response?.data || e.message);
    res.status(500).json({ success: false, error: 'SMS 전송 실패' });
  }
});

// 헬스 체크
app.get('/', (req, res) => res.send('Hello Backend!'));

// 서버 시작
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('🚀 서버 실행 중: ' + PORT));
```
