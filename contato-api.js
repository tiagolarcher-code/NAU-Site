// contato-api.js — backend de formulário de contacto NAU
// Porta: 3001  |  Envia via Resend API  |  Email NUNCA aparece no HTML
// Variáveis de ambiente obrigatórias:
//   RESEND_KEY   — chave da API Resend (re_...)
//   DEST_EMAIL   — endereço de destino (ex: tiagolarcher@nauassessoria.com)
// Uso: node contato-api.js
// Produção: PM2 ou systemd (ver README abaixo)

'use strict';

const http  = require('http');
const https = require('https');

const PORT      = process.env.PORT      || 3001;
const RESEND_KEY = process.env.RESEND_KEY;
const DEST_EMAIL = process.env.DEST_EMAIL;

if (!RESEND_KEY) { console.error('[contato-api] RESEND_KEY não definida.'); process.exit(1); }
if (!DEST_EMAIL) { console.error('[contato-api] DEST_EMAIL não definida.'); process.exit(1); }

// ── helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 20000) { reject(new Error('Payload demasiado grande')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendResend(nome, email, mensagem) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: 'NAU Assessoria <formulario@nauassessoria.com>',
      to:   [DEST_EMAIL],
      reply_to: email,
      subject: `[NAU] Mensagem de ${nome}`,
      html: `
        <p><strong>Nome:</strong> ${esc(nome)}</p>
        <p><strong>E-mail:</strong> ${esc(email)}</p>
        <p><strong>Mensagem:</strong></p>
        <p style="white-space:pre-wrap">${esc(mensagem)}</p>
      `.trim()
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path:     '/emails',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Resend ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': 'https://nauassessoria.com'
  });
  res.end(body);
}

// ── servidor ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  'https://nauassessoria.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // Apenas POST /contato  (Caddy vai proxy /api/contato → 127.0.0.1:3001/contato)
  if (req.method !== 'POST' || req.url !== '/contato') {
    return json(res, 404, { erro: 'Not found' });
  }

  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { erro: 'Payload inválido' }); }

  let data;
  try { data = JSON.parse(body); }
  catch (e) { return json(res, 400, { erro: 'JSON inválido' }); }

  const nome     = String(data.nome     || '').trim();
  const email    = String(data.email    || '').trim();
  const mensagem = String(data.mensagem || '').trim();

  if (!nome || !email || !mensagem) {
    return json(res, 422, { erro: 'Campos obrigatórios em falta' });
  }

  // Validação básica de email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(res, 422, { erro: 'E-mail inválido' });
  }

  try {
    await sendResend(nome, email, mensagem);
    console.log(`[contato-api] email enviado de ${email} às ${new Date().toISOString()}`);
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('[contato-api] erro Resend:', e.message);
    return json(res, 500, { erro: 'Falha ao enviar email' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[contato-api] a correr em 127.0.0.1:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });

/*
══════════════════════════════════════════════════════════════
  DEPLOY — passo a passo no servidor (201.54.20.80)
══════════════════════════════════════════════════════════════

1. Copiar este ficheiro para o servidor:
   scp contato-api.js ubuntu@201.54.20.80:/home/ubuntu/

2. Criar ficheiro de variáveis de ambiente:
   ssh ubuntu@201.54.20.80
   cat << 'EOF' | sudo tee /etc/contato-api.env
   RESEND_KEY=re_COLOCA_AQUI_A_TUA_CHAVE
   DEST_EMAIL=tiagolarcher@nauassessoria.com
   EOF
   sudo chmod 600 /etc/contato-api.env

   (Obter a chave em: https://resend.com → API Keys → Create API Key)
   (Verificar o domínio nauassessoria.com no painel Resend → Domains)

3. Mover o script para /srv:
   sudo cp /home/ubuntu/contato-api.js /srv/contato-api.js

4. Criar serviço systemd:
   sudo tee /etc/systemd/system/contato-api.service << 'EOF'
   [Unit]
   Description=NAU Contato API
   After=network.target

   [Service]
   ExecStart=/usr/bin/node /srv/contato-api.js
   EnvironmentFile=/etc/contato-api.env
   User=www-data
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   EOF

5. Activar e iniciar:
   sudo systemctl daemon-reload
   sudo systemctl enable contato-api
   sudo systemctl start contato-api
   sudo systemctl status contato-api

6. Adicionar ao Caddyfile ( /etc/caddy/Caddyfile ):
   Dentro do bloco "nauassessoria.com { ... }" adicionar ANTES das regras existentes:

   handle /api/contato {
     reverse_proxy 127.0.0.1:3001/contato {
       header_up Host {host}
     }
   }

   Depois: sudo systemctl reload caddy

7. Testar:
   curl -s -X POST https://nauassessoria.com/api/contato \
     -H 'Content-Type: application/json' \
     -d '{"nome":"Teste","email":"teste@exemplo.com","mensagem":"Olá"}' | python3 -m json.tool

   Resposta esperada: {"ok": true}
══════════════════════════════════════════════════════════════
*/
