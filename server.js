// server.js — pronto pra deploy
import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import axios from 'axios';

const app = express();
// usa SERVER_PORT (Pterodactyl), PORT (Railway/Render) ou 3000 local
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -------- utils EF --------
async function getAuthToken(ra, password) {
  const response = await fetch('https://edusp-api.ip.tv/registration/edusp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-platform': 'webclient',
      'x-api-realm': 'edusp'
    },
    body: JSON.stringify({
      realm: 'edusp',
      platform: 'webclient',
      id: ra,
      password
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.message || response.statusText);
  if (!data.auth_token) throw new Error(data.message || 'Token de autenticação não encontrado.');
  return data.auth_token;
}

async function getJwtToken(authToken) {
  const response = await fetch('https://edusp-api.ip.tv/mas/external-auth/seducsp_token/generate?card_label=SPeak', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-api-key': authToken,
      'x-api-platform': 'webclient',
      'x-api-realm': 'edusp'
    }
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.message || response.statusText);
  if (!data.token) throw new Error(data.message || 'Token JWT não encontrado.');
  return data.token;
}

async function setLevel(tokens, levelId, courseId) {
  try {
    const { data } = await axios.put(
      'https://learn.corporate.ef.com/wl/api/study-plan/study-plan',
      { courseId, levelId },
      {
        headers: {
          Authorization: `Bearer ${tokens.access}`,
          'x-ef-access': tokens.account,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );
    return data;
  } catch (error) {
    if (error.response) {
      console.error('EF setLevel error data:', error.response.data);
      console.error('EF setLevel status:', error.response.status);
    }
    throw error;
  }
}

async function fetchTasks(levelId, courseId, efAccessToken, efAccessAccount) {
  try {
    const url = `https://learn.corporate.ef.com/wl/api/study-plan/study-plan?locale=en&clientTimezone=America%2FSao_Paulo&courseId=${courseId}&levelId=${levelId}`;
    const { data } = await axios.get(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${efAccessToken}`,
        'x-ef-access': efAccessAccount,
        'x-ef-correlation-id': 'R3Dq5eAUEUoCWiANsW5XL'
      },
      timeout: 60000
    });
    return data.children;
  } catch (error) {
    if (error.response) {
      console.error('EF tasks error data:', error.response.data);
      console.error('EF tasks status:', error.response.status);
    }
    throw error;
  }
}

// -------- rotas --------
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', port: PORT });
});

app.post('/api/login', async (req, res) => {
  let browser;
  try {
    const { ra, password } = req.body;
    if (!ra || !password) return res.status(400).json({ error: 'Informe ra e password.' });

    const authToken = await getAuthToken(ra, password);
    const jwtToken = await getJwtToken(authToken);

    // Puppeteer preparado para container / serverless com binário opcional
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH // ex: '/usr/bin/chromium' (VPS/Docker). Deixe vazio no Railway.
    });

    const page = await browser.newPage();
    const loginUrl = `https://learn.corporate.ef.com/login/v1/login/oauth2/initiate?state=/&initiator=SCHOOL_WEB&prompt=login&domain_hint=saopaulo&partnerCode=SANP-J04NSMP9&sso_token_hint=${jwtToken}`;
    await page.goto(loginUrl, { waitUntil: 'networkidle0', timeout: 120000 });

    // tempo para o SSO propagar cookies
    await page.waitForTimeout(5000);

    const efidTokensCookie = (await page.cookies()).find((c) => c.name === 'efid_tokens');
    if (!efidTokensCookie) throw new Error("Cookie 'efid_tokens' não encontrado. Login SSO falhou.");

    const efidTokens = JSON.parse(decodeURIComponent(efidTokensCookie.value));
    const efAccessToken = efidTokens.access;
    const efAccessAccount = efidTokens.account;
    if (!efAccessToken || !efAccessAccount) throw new Error('Não foi possível obter tokens EF.');

    // consulta níveis já autenticado
    const apiResponse = await page.evaluate(async (token, account) => {
      const r = await fetch('https://learn.corporate.ef.com/wl/api/change-level/levels?locale=en', {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'x-ef-access': account,
          'x-ef-correlation-id': 'EN-XS3EHEBXam436Y0HX3'
        }
      });
      if (!r.ok) throw new Error(`Falha ao buscar níveis: ${r.status} - ${await r.text()}`);
      return await r.json();
    }, efAccessToken, efAccessAccount);

    res.json({ efAccessToken, efAccessAccount, ...apiResponse });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: `Erro no processo de login: ${error.message}` });
  } finally {
    if (browser) await browser.close();
  }
});

app.put('/api/change-level', async (req, res) => {
  try {
    const { levelId, courseId, efAccessToken, efAccessAccount } = req.body;
    if (!levelId || !courseId || !efAccessToken || !efAccessAccount) {
      return res.status(400).json({ error: 'Campos obrigatórios: levelId, courseId, efAccessToken, efAccessAccount.' });
    }
    const tokens = { access: efAccessToken, account: efAccessAccount };
    const result = await setLevel(tokens, levelId, courseId);
    res.json(result);
  } catch (error) {
    const msg = error.response?.data?.error || error.message;
    res.status(error.response?.status || 500).json({ error: `Erro ao mudar de nível: ${msg}` });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { levelId, courseId, efAccessToken, efAccessAccount } = req.body;
    if (!levelId || !courseId || !efAccessToken || !efAccessAccount) {
      return res.status(400).json({ error: 'Campos obrigatórios: levelId, courseId, efAccessToken, efAccessAccount.' });
    }
    const tasks = await fetchTasks(levelId, courseId, efAccessToken, efAccessAccount);
    res.json({ tasks });
  } catch (error) {
    const msg = error.response?.data?.error || error.message;
    res.status(error.response?.status || 500).json({ error: `Erro ao buscar tasks: ${msg}` });
  }
});

// -------- start --------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
