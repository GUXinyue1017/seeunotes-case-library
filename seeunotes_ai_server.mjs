import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

const prompt = await readFile(
  path.join(root, 'seeunotes_case_extraction_prompt.md'),
  'utf8'
);

// Render 会自动提供 PORT
const port = Number(process.env.PORT || 4317);

// 防止用户重复点击，同时发起多个 AI 请求
const active = new Set();

async function config() {
  return {
    baseUrl: process.env.SEEUNOTES_API_BASE_URL,
    model: process.env.SEEUNOTES_MODEL,
    apiKey: process.env.SEEUNOTES_API_KEY
  };
}

function corsHeaders(req) {
  const origin = req.headers.origin || '';

  const allowed = new Set([
    'https://notes.seeulab.com',
    'https://guxinyue1017.github.io',
    'http://localhost:4317',
    'http://127.0.0.1:4317'
  ]);

  return {
    'Access-Control-Allow-Origin': allowed.has(origin)
      ? origin
      : 'https://notes.seeulab.com',

    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
}

function send(req, res, status, data) {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8'
  });

  res.end(JSON.stringify(data));
}

function strings(value, field, max) {
  if (
    !Array.isArray(value) ||
    value.some(s => typeof s !== 'string')
  ) {
    throw new Error(
      'AI 返回的 ' + field + ' 格式不正确，请重试。'
    );
  }

  return [
    ...new Set(
      value
        .map(s => s.trim())
        .filter(Boolean)
    )
  ].slice(0, max);
}

function named(value, field, max) {
  if (!Array.isArray(value)) {
    throw new Error(
      'AI 返回的 ' + field + ' 格式不正确，请重试。'
    );
  }

  return value
    .slice(0, max)
    .map(v => {
      if (
        !v ||
        typeof v.tag !== 'string' ||
        typeof v.text !== 'string'
      ) {
        throw new Error(
          'AI 返回的 ' + field + ' 格式不正确，请重试。'
        );
      }

      return {
        tag: v.tag.trim().slice(0, 12),
        text: v.text.trim(),
        caseIds: v.caseIds
      };
    })
    .filter(v => v.text);
}

export function normalizeNote(result, raw, title) {
  if (
    !result ||
    !Array.isArray(result.cases) ||
    !result.cases.length
  ) {
    throw new Error(
      'AI 没有返回可用案例，请重试。'
    );
  }

  const source = raw.replace(/\s/g, '');

  const cases = result.cases.map((c, index) => {
    if (
      !c ||
      typeof c.title !== 'string' ||
      typeof c.subtitle !== 'string'
    ) {
      throw new Error(
        'AI 返回的案例标题格式不正确。'
      );
    }

    const advice = named(
      c.advice,
      '案例建议',
      8
    );

    const universal = named(
      c.universal,
      '通用建议',
      5
    );

    if (!Array.isArray(c.review)) {
      throw new Error(
        'AI 返回的复习问答格式不正确。'
      );
    }

    const review = c.review
      .slice(0, 4)
      .map(q => {
        if (
          typeof q.question !== 'string' ||
          typeof q.answer !== 'string'
        ) {
          throw new Error(
            'AI 返回的复习问答格式不正确。'
          );
        }

        return {
          question: q.question.trim(),
          answer: q.answer.trim()
        };
      })
      .filter(
        q => q.question && q.answer
      );

    return {
      id: index + 1,

      title:
        c.title.trim(),

      subtitle:
        c.subtitle.trim(),

      kicker:
        String(c.kicker || '')
          .slice(0, 12),

      background:
        strings(
          c.background,
          '背景',
          6
        ),

      core:
        strings(
          c.core,
          '核心问题',
          4
        ),

      advice:
        advice.map(v => v.text),

      adviceTags:
        advice.map(v => v.tag),

      universal:
        universal.map(v => v.text),

      universalTags:
        universal.map(v => v.tag),

      quotes:
        strings(
          c.quotes,
          '金句',
          5
        ).filter(q =>
          source.includes(
            q.replace(/\s/g, '')
          )
        ),

      methods:
        universal.map(v => v.text),

      review,

      raw: '',

      expertNamed: true
    };
  });

  const methods = named(
    result.methods,
    '底层方法论',
    10
  );

  const collect = key => [
    ...new Set(
      cases.flatMap(c => c[key])
    )
  ];

  return {
    title:
      title ||
      String(
        result.title ||
        '案例学习笔记'
      ),

    summary:
      String(result.summary || ''),

    subtitle:
      cases
        .map(c => c.title)
        .join(' · '),

    cases,

    background:
      cases.map(c => c.subtitle),

    core:
      collect('core'),

    advice:
      collect('advice'),

    universal:
      collect('universal'),

    quotes:
      collect('quotes'),

    methods:
      methods.map(m => m.text),

    methodTags:
      methods.map(m => m.tag),

    methodCaseIds:
      methods.map(m =>
        Array.isArray(m.caseIds)
          ? m.caseIds.filter(
              id =>
                Number.isInteger(id) &&
                id >= 1 &&
                id <= cases.length
            )
          : []
      ),

    raw,

    extractionVersion: 2,

    engine: 'ai'
  };
}

function parseModelJSON(text) {
  const clean = String(text)
    .trim()
    .replace(
      /^```(?:json)?\s*/,
      ''
    )
    .replace(
      /\s*```$/,
      ''
    );

  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error(
      '[JSON PARSE ERROR]',
      e
    );

    console.error(
      '[AI RAW CONTENT]',
      clean.slice(0, 3000)
    );

    throw new Error(
      'AI 返回的内容不是完整 JSON，请重试。'
    );
  }
}

async function generate(body, signal) {
  if (
    typeof body.text !== 'string' ||
    !body.text.trim()
  ) {
    throw new Error(
      '文字材料为空。'
    );
  }

  // 当前允许最多 20 万字符
  if (body.text.length > 200000) {
    throw new Error(
      '材料超过 20 万字，请分成几份上传。'
    );
  }

  const settings =
    await config();

  if (
    !settings.baseUrl ||
    !settings.model ||
    !settings.apiKey
  ) {
    throw new Error(
      '服务器 API 配置不完整，请检查 Render 环境变量。'
    );
  }

  const endpoint =
    settings.baseUrl
      .replace(/\/+$/, '') +
    (
      settings.baseUrl
        .endsWith(
          '/chat/completions'
        )
        ? ''
        : '/chat/completions'
    );

  console.log(
    '[AI START]',
    {
      model:
        settings.model,

      chars:
        body.text.length,

      endpoint,

      title:
        body.title || '',

      fileName:
        body.fileName || ''
    }
  );

  const startedAt =
    Date.now();

  const response =
    await fetch(
      endpoint,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'Authorization':
            'Bearer ' +
            settings.apiKey
        },

        signal,

        body:
          JSON.stringify({
            model:
              settings.model,

            messages: [
              {
                role:
                  'system',

                content:
                  prompt
              },

              {
                role:
                  'user',

                content:
                  JSON.stringify({
                    title:
                      body.title || '',

                    fileName:
                      body.fileName || '',

                    material:
                      body.text
                  })
              }
            ]
          })
      }
    );

  console.log(
    '[AI RESPONSE]',
    {
      status:
        response.status,

      statusText:
        response.statusText,

      durationMs:
        Date.now() -
        startedAt
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    console.error(
      '[AI ERROR BODY]',
      errorText.slice(
        0,
        3000
      )
    );

    throw new Error(
      'API 请求失败（' +
      response.status +
      '），请检查配置、额度和模型权限。'
    );
  }

  const data =
    await response.json();

  const choice =
    data.choices?.[0];

  if (
    choice?.finish_reason ===
    'length'
  ) {
    throw new Error(
      'AI 输出被截断，请分成较短的材料再生成。'
    );
  }

  if (
    typeof choice
      ?.message
      ?.content !==
    'string'
  ) {
    console.error(
      '[INVALID AI RESPONSE]',
      JSON.stringify(data)
        .slice(0, 3000)
    );

    throw new Error(
      'API 没有返回文字，请检查接口兼容性。'
    );
  }

  console.log(
    '[AI CONTENT RECEIVED]',
    {
      chars:
        choice
          .message
          .content
          .length,

      finishReason:
        choice
          .finish_reason
    }
  );

  const parsed =
    parseModelJSON(
      choice.message.content
    );

  console.log(
    '[AI JSON PARSED]',
    {
      cases:
        Array.isArray(
          parsed?.cases
        )
          ? parsed.cases.length
          : 0
    }
  );

  return normalizeNote(
    parsed,
    body.text,
    body.title
  );
}

const server =
  http.createServer(
    async (req, res) => {

      // 浏览器跨域预检
      if (
        req.method ===
        'OPTIONS'
      ) {
        res.writeHead(
          204,
          corsHeaders(req)
        );

        res.end();
        return;
      }

      const url =
        new URL(
          req.url,
          'http://localhost:' +
          port
        );

      console.log(
        '[REQUEST]',
        req.method,
        url.pathname,
        new Date()
          .toISOString()
      );

      // 健康检查
      if (
        req.method === 'GET' &&
        url.pathname === '/'
      ) {
        send(
          req,
          res,
          200,
          {
            ok: true,
            service:
              'SeeUNotes API'
          }
        );

        return;
      }

      // 配置检查
      if (
        req.method === 'GET' &&
        url.pathname ===
          '/api/status'
      ) {
        const c =
          await config();

        send(
          req,
          res,
          200,
          {
            configured:
              Boolean(
                c.baseUrl &&
                c.model &&
                c.apiKey
              ),

            model:
              c.model || '',

            busy:
              active.size > 0
          }
        );

        return;
      }

      // 只处理生成接口
      if (
        req.method !==
          'POST' ||
        url.pathname !==
          '/api/generate'
      ) {
        send(
          req,
          res,
          404,
          {
            error:
              '页面不存在。'
          }
        );

        return;
      }

      // 防止重复提交
      if (active.size) {
        console.warn(
          '[BUSY]',
          'Another generation is already running.'
        );

        send(
          req,
          res,
          429,
          {
            error:
              '当前笔记正在生成，请稍候。'
          }
        );

        return;
      }

      const controller =
        new AbortController();

      active.add(
        controller
      );

      console.log(
        '[JOB START]',
        {
          active:
            active.size
        }
      );

      // 大文件最长允许 10 分钟
      const timeout =
        setTimeout(
          () => {
            console.error(
              '[TIMEOUT]',
              'Generation exceeded 10 minutes.'
            );

            controller.abort();
          },
          600000
        );

      try {
        let size = 0;

        const chunks = [];

        for await (
          const chunk
          of req
        ) {
          size +=
            chunk.length;

          if (
            size >
            1600000
          ) {
            throw new Error(
              '文件太大，请分成几份上传。'
            );
          }

          chunks.push(
            chunk
          );
        }

        console.log(
          '[REQUEST BODY RECEIVED]',
          {
            bytes:
              size
          }
        );

        const body =
          JSON.parse(
            Buffer
              .concat(chunks)
              .toString(
                'utf8'
              )
          );

        console.log(
          '[MATERIAL READY]',
          {
            chars:
              typeof body.text ===
              'string'
                ? body.text.length
                : 0,

            fileName:
              body.fileName ||
              '',

            title:
              body.title ||
              ''
          }
        );

        const note =
          await generate(
            body,
            controller.signal
          );

        console.log(
          '[JOB SUCCESS]',
          {
            title:
              note.title,

            cases:
              Array.isArray(
                note.cases
              )
                ? note
                    .cases
                    .length
                : 0
          }
        );

        send(
          req,
          res,
          200,
          {
            note
          }
        );

      } catch (e) {

        console.error(
          '[ERROR]',
          e
        );

        send(
          req,
          res,
          400,
          {
            error:
              e.name ===
              'AbortError'
                ? '生成超时，请稍后重试。'
                : e.message
          }
        );

      } finally {

        clearTimeout(
          timeout
        );

        active.delete(
          controller
        );

        console.log(
          '[JOB END]',
          {
            active:
              active.size
          }
        );
      }
    }
  );

// 云端必须监听 0.0.0.0
server.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `SeeUNotes API running on port ${port}`
    );
  }
);
