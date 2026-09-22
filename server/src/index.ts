import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, seedIfEmpty } from './db.js';
import { recordScheduleVersion } from './audit.js';
import { api } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

migrate();
if (process.env.SEED_DEMO !== '0' && seedIfEmpty()) {
  // 演示数据落库后记录首个排程审计版本，作为后续保存的比较起点
  recordScheduleVersion({ kind: 'init', note: '演示数据初始版本（后续保存将与此版比较）' });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/api', api);
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 生产模式：托管前端构建产物（client/dist 与 server/dist 同级）
const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`[server] 连续性校验服务已启动: http://localhost:${port}`);
});
