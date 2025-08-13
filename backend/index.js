// index.js (변경됨)
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const { sendSMS } = require('./smsNcloud'); // 또는 './sms' (사용중인 모듈로)

const app = express();
app.use(express.json());

app.use(cors({
  origin: [
    'https://credit-namecheck.netlify.app',
    'https://credit-namecheck.netlify.app/'
  ]
}));

// In-memory 저장소 (데모용)
const store = new Map();

/* ---------------- PortOne helpers ---------------- */
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

async function getCertificationByImpUid(certImpUid) {
  const token = await getPortoneToken();
  const res = await axios.get(
    `https://api.iamport.kr/certifications/${certImpUid}`,
    { headers: { Authorization: token } }
  );
  return res.data.response; // { name, phone, ... }
}

/* ---------------- Mobile hash (선택) ---------------- */
function makeMobileHash(params) {
  const msg = '' + params.mid + params.oid + params.price + params.timestamp;
  return crypto
    .createHmac('sha256', process.env.MOBILE_HASHKEY)
    .update(msg)
    .digest('hex');
}

/* ---------------- Masking utils ---------------- */
function maskName(name) {
  if (!name) return '-';
  const s = name.trim();
  if (s.length <= 1) return '*';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1]; // 예: 최문석 → 최*석
}

function formatKoreanMobile(digits) {
  const d = (digits || '').replace(/\D/g, '');
  if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7,11)}`; // 3-4-4
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6,10)}`; // 3-3-4
  return digits; // fallback
}

function maskPhoneKorea(digits) {
  const d = (digits || '').replace(/\D/g, '');
  let a, b, c;
  if (d.length === 11) { a = d.slice(0,3); b = d.slice(3,7); c = d.slice(7,11); }
  else if (d.length === 10) { a = d.slice(0,3); b = d.slice(3,6); c = d.slice(6,10); }
  else { // 기타 길이: 중간을 별표 처리
    if (d.length <= 4) return d.replace(/.(?=..)/g, '*');
    const head = d.slice(0,3);
    const tail = d.slice(-2);
    return `${head}${'*'.repeat(Math.max(1, d.length-5))}${tail}`;
  }
  // 요구안: 중간그룹과 마지막그룹의 2번째 글자 마스킹
  if (b.length >= 2) b = b[0] + '*' + b.slice(2);
  if (c.length >= 2) c = c[0] + '*' + c.slice(2);
  return `${a}-${b}-${c}`; // 예: 010-7*75-1*67
}

/* ---------------- APIs ---------------- */

// 1) 결제 완료 → 인증 요청 생성(결제 검증 + 인증 링크 전송)
app.post('/api/createRequest', async (req, res) => {
  const imp_uid = req.body.imp_uid;
  const merchant_uid = req.body.merchant_uid;
  const requesterPhone = req.body.phone; // 상대방 번호(링크 받을 대상)

  try {
    // 결제 검증
    const token = await getPortoneToken();
    const payment = await axios.get(
      'https://api.iamport.kr/payments/' + imp_uid,
      { headers: { Authorization: token } }
    );
    const { status, amount } = payment.data.response;
    if (status !== 'paid' || amount !== 1000) {
      return res.status(400).json({ success: false, error: '결제 검증 실패' });
    }

    // 요청 저장
    store.set(merchant_uid, {
      requesterPhone,     // 링크 받는 상대방 번호
      recvPhone: null,    // 결제자가 결과 받을 번호
      verifyStatus: 'pending',
      updatedAt: Date.now()
    });

    // 인증 링크 전송
    const link = 'https://credit-namecheck.netlify.app/namecheck.html?id=' + merchant_uid;
    await sendSMS(requesterPhone, '[크레디톡] 본인인증 요청\n' + link);

    res.json({ success: true });
  } catch (err) {
    console.error('[createRequest] 에러 →', err.response?.data || err.message);
    res.status(500).json({ success: false, error: '서버 내부 오류' });
  }
});

// 2) 결과 수신 번호 저장
app.post('/api/saveReceiver', (req, res) => {
  const merchant_uid = req.body.merchant_uid;
  const recvPhone = req.body.recv_phone;
  const record = store.get(merchant_uid);

  if (!record) {
    return res.status(404).json({ success: false, error: '요청 없음' });
  }
  record.recvPhone = recvPhone;
  record.updatedAt = Date.now();
  res.json({ success: true });
});

// 3) 본인인증 결과 처리(+ 성공 시 인증정보 조회·마스킹 후 SMS)
app.post('/api/verifyResult', async (req, res) => {
  let { merchant_uid, result, cert_imp_uid } = req.body;

  // partial UID 매칭 지원
  if (!store.has(merchant_uid)) {
    const match = Array.from(store.keys()).find(k => k.startsWith(merchant_uid));
    if (match) merchant_uid = match;
  }

  const record = store.get(merchant_uid);
  if (!record || !record.recvPhone) {
    return res.status(404).json({ success: false, error: '수신 번호 미등록' });
  }
  if (record.verifyStatus !== 'pending') {
    return res.status(409).json({ success: false, error: '이미 처리됨' });
  }

  record.verifyStatus = result;
  record.updatedAt = Date.now();

  let msg;
  if (result === 'success') {
    let maskedName = '-';
    let maskedPhone = '-';
    try {
      if (cert_imp_uid) {
        const cert = await getCertificationByImpUid(cert_imp_uid); // { name, phone, ... }
        maskedName  = maskName(cert?.name || '');
        maskedPhone = maskPhoneKorea(cert?.phone || '');
      }
    } catch (e) {
      // 인증정보 조회 실패 시, 마스킹 정보 없이 성공 문구만 발송 (PII 미노출)
      console.error('[verifyResult] 인증정보 조회 실패 →', e.response?.data || e.message);
    }

    // 성공 메시지(인증정보가 있으면 포함)
    msg = (maskedName !== '-' && maskedPhone !== '-')
      ? `[크레디톡] 본인인증이 완료되었습니다.\n이름 : ${maskedName}\n전화번호 : ${maskedPhone}`
      : `[크레디톡] 본인인증이 완료되었습니다.`;
  } else {
    msg = '[크레디톡] 상대방이 본인인증에 실패했습니다. 거래에 유의하세요.';
  }

  try {
    await sendSMS(record.recvPhone, msg);
    res.json({ success: true });
  } catch (err) {
    console.error('[verifyResult] SMS 전송 실패 →', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'SMS 전송 실패' });
  }
});

// 헬스 체크
app.get('/', (req, res) => res.send('Hello Backend!'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('🚀 서버 실행 중: ' + PORT));
