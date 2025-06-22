require('dotenv').config();
const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('Hello Backend!'));
app.listen(4000, () => console.log('서버가 4000 포트에서 작동중입니다.'));
