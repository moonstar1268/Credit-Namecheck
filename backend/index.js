// index.js
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const { sendSMS } = require('./smsNcloud'); // NCP SENS 사용

const app = express();
app.use(express.json());

app.use(cors({
  origin: [
    'https://credit-namecheck.netlify.app',
    'https://credit-namecheck.netlify.app/'
  ]
}));

// 데모용 메모리 저장
const store = new Map();

/* ---------- PortOne helpers ---------- */
async function getPortoneToken() {
  const response = await axios.post('https://api.iamport.kr/users/getToken', {
    imp_key: process.env.IMP_KEY,
    imp_secret: process.env.IMP_SECRET
  });
  return response.data.response.access_token;
}

async function getCertificationByImpUid(certImpUid) {
  const token = await getPortoneToken();
  const res = await axios.get(
    `https://api.iamport.kr/certifications/${certImpUid}`,
    { headers: { Authorization: token } }
  );
  return res.data.response || {}; // { name, gender, birth, phone, ... }
}

/* ---------- (선택) 모바일 해시 ---------- */
function makeMobileHash(params) {
  const msg = '' + params.mid + params.oid + params.price + params.timestamp;
  return crypto.createHmac('sha256', process.env.MOBILE_HASHKEY).update(msg).digest('hex');
}

/* ---------- 유틸: 성별/연령/전화 마스킹 ---------- */
function mapGenderToKr(g) {
  if (!g && g !== 0) return '-';
  const s = String(g).toLowerCase();
  if (['male','m','1','3','5','7'].includes(s))  return '남자';
  if (['female','f','2','4','6','8'].includes(s)) return '여자';
  return '-';
}

function toDecadeKrFromBirthLike(birthLike) {
  if (!birthLike) return '-';
  const ds = String(birthLike).replace(/\D/g,'');
  if (ds.length < 4) return '-';
  const yyyy = parseInt(ds.slice(0,4), 10);
  if (isNaN(yyyy) || yyyy < 1900 || yyyy > 2100) return '-';
  const now = new Date();
  const age = now.getFullYear() - yyyy; // 대략적인 연령대 계산
  if (age < 0 || age > 120) return '-';
  const decade = Math.floor(age / 10) * 10;
  return decade >= 10 ? `${decade}대` : '10대 미만';
}

// 가운데(중간 블록) 앞 2자리만 '**'로 마스킹, 구분자는 'ㅡ'
function maskPhoneMiddleTwoKorea(digits) {
  const d = (digits || '').replace(/\D/g,'');
  let a,b,c;
  if (d.length === 11) { a=d.slice(0,3); b=d.slice(3,7); c=d.slice(7,11); }
  else if (d.length === 10) { a=d.slice(0,3); b=d.slice(3,6); c=d.slice(6,10); }
  else return '-';
  if (b.length >= 2) b = '**' + b.slice(2);
  else if (b.length === 1) b = '*';
  else b = '**';
  const SEP = 'ㅡ';
  return `${a}${SEP}${b}${SEP}${c}`;
}

/* ---------- APIs ---------- */

// 1) 결제 완료 → 인증요청 생성
app.post('/api/createRequest', async (req, res) => {
  const imp_uid = req.body.imp_uid;
  const merchant_uid = req.body.merchant_uid;
  const requesterPhone = req.body.phone; // 인증을 수행할 상대방 번호

  try {
    // 결제 검증
    const token = await getPortoneToken();
    const payment = await axios.get(
      'https://api.iamport.kr/payments/' + imp_uid,
      { headers: { Authorization: token } }
    );
    const { status, amount } = payment.data.response;
    if (status !== 'paid' || amount !== 1000) {
      return res.status(400).json({ success:false, error:'결제 검증 실패' });
    }

    store.set(merchant_uid, {
      requesterPhone,          // 인증 링크 수신자(=인증 당사자)
      recvPhone: null,         // 결제자가 결과 받을 번호
      verifyStatus: 'pending',
      updatedAt: Date.now()
    });

    // 기대 전화번호를 namecheck에 쿼리로 넘겨 다날 인증창에서 고정
    const link =
      'https://credit-namecheck.netlify.app/namecheck.html'
      + `?id=${encodeURIComponent(merchant_uid)}`
      + `&expectedPhone=${encodeURIComponent(requesterPhone)}`;

    await sendSMS(requesterPhone, `[크레디톡] 본인인증 요청\n${link}`);

    res.json({ success:true });
  } catch (err) {
    console.error('[createRequest] 에러 →', err.response?.data || err.message);
    res.status(500).json({ success:false, error:'서버 내부 오류' });
  }
});

// 2) 결과 수신 번호 저장 (결제자가 결과 받을 번호)
app.post('/api/saveReceiver', (req, res) => {
  const merchant_uid = req.body.merchant_uid;
  const recvPhone = req.body.recv_phone;
  const record = store.get(merchant_uid);
  if (!record) return res.status(404).json({ success:false, error:'요청 없음' });
  record.recvPhone = recvPhone;
  record.updatedAt = Date.now();
  res.json({ success:true });
});

// 3) 본인인증 결과 처리 → 이름/성별/연령대/전화 전송
app.post('/api/verifyResult', async (req, res) => {
  let { merchant_uid, result, cert_imp_uid } = req.body;

  // partial UID 허용
  if (!store.has(merchant_uid)) {
    const match = Array.from(store.keys()).find(k => k.startsWith(merchant_uid));
    if (match) merchant_uid = match;
  }

  const record = store.get(merchant_uid);
  if (!record || !record.recvPhone) {
    return res.status(404).json({ success:false, error:'수신 번호 미등록' });
  }
  if (record.verifyStatus !== 'pending') {
    return res.status(409).json({ success:false, error:'이미 처리됨' });
  }

  record.verifyStatus = result;
  record.updatedAt = Date.now();

  let msg;
  if (result === 'success') {
    let nameKr = '-';
    let genderKr = '-';
    let decadeKr = '-';
    let phoneMasked = '-';

    try {
      if (cert_imp_uid) {
        const cert = await getCertificationByImpUid(cert_imp_uid);

        // 어떤 키가 왔는지 안전 로그(값 길이만) — 운영 중엔 제거 가능
        const safeLog = {};
        Object.keys(cert || {}).forEach(k => {
          const v = cert[k];
          const t = typeof v;
          safeLog[k] = (v == null) ? null : (t === 'string' ? `${t}(${v.length})` : t);
        });
        console.log('[cert payload keys]', safeLog);

        // 여러 후보 키에서 안전 추출
        const rawName  = cert?.name || cert?.certified_name || '';
        const rawGender =
          cert?.gender || cert?.sex || cert?.genderCode || '';
        const rawBirth =
          cert?.birthday ||             // "YYYY-MM-DD" 형식
          cert?.birth    ||             // 19980620 (number/string)
          cert?.birthdate || cert?.birthDate || cert?.yyyyMMdd || '';
        const rawPhone =
          cert?.phone  || cert?.phone_number || cert?.phoneNo ||
          cert?.mobile || cert?.mobile_number || cert?.cellphone ||
          cert?.carrier_phone || cert?.tel || '';

        nameKr     = rawName || '-';
        genderKr   = mapGenderToKr(rawGender);
        decadeKr   = toDecadeKrFromBirthLike(rawBirth);
        phoneMasked= rawPhone ? maskPhoneMiddleTwoKorea(rawPhone) : '-';
      }
    } catch (e) {
      console.error('[verifyResult] 인증조회 실패 →', e.response?.data || e.message);
    }

    // 최종 포맷 (요청하신 형식)
    msg = `[크레디톡]\n${nameKr}\n${genderKr}\n${decadeKr}\n${phoneMasked}`;
  } else {
    msg = '[크레디톡]\n본인인증 실패\n거래에 유의하세요.';
  }

  try {
    await sendSMS(record.recvPhone, msg); // smsNcloud가 길이에 따라 SMS/LMS 전환
    res.json({ success:true });
  } catch (err) {
    console.error('[verifyResult] SMS 전송 실패 →', err.response?.data || err.message);
    res.status(500).json({ success:false, error:'SMS 전송 실패' });
  }
});

// 헬스 체크
app.get('/', (_, res) => res.send('Hello Backend!'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('🚀 서버 실행 중: ' + PORT));
