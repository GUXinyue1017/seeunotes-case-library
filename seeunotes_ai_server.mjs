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
const jobs=new Map();
function pruneJobs(){for(const [id,job] of jobs){if(job.finishedAt && Date.now()-job.finishedAt>3600000)jobs.delete(id);}}
const cleanup=setInterval(pruneJobs,60000);cleanup.unref();

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

// Match normalized anchors but always slice the untouched source with mapped offsets.
function indexedText(text,loose=false,skipMetadata=false){
  const skip=new Set();
  if(skipMetadata){
    const pattern=/^\s*(?:[^\r\n]{0,60}\s+)?\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/gm;
    for(const match of text.matchAll(pattern))for(let i=match.index;i<match.index+match[0].length;i++)skip.add(i);
  }
  let normalized='';const starts=[],ends=[];
  for(let offset=0;offset<text.length;){
    const ch=String.fromCodePoint(text.codePointAt(offset));const end=offset+ch.length;
    if(skip.has(offset)){offset=end;continue;}
    const value=loose?ch.normalize('NFKC'):ch;
    for(const unit of value){
      if(/\s/u.test(unit)||(loose&&/\p{P}/u.test(unit)))continue;
      normalized+=unit;
      for(let j=0;j<unit.length;j++){starts.push(offset);ends.push(end);}
    }
    offset=end;
  }
  return {text:normalized,starts,ends};
}
function occurrences(haystack,needle,from=0,to=haystack.length){
  const found=[];if(!needle)return found;
  let at=haystack.indexOf(needle,from);
  while(at>=0&&at+needle.length<=to){found.push(at);at=haystack.indexOf(needle,at+1);}
  return found;
}
export function sliceCaseTranscripts(raw,cases){
  const indexes=[indexedText(raw),indexedText(raw,true),indexedText(raw,true,true)];let cursor=0;
  return cases.map((c,i)=>{
    let reason='missing-anchors';
    for(let mode=0;mode<3;mode++){
      const index=indexes[mode];
      const start=indexedText(String(c.rawStart||''),!!mode).text;
      const end=indexedText(String(c.rawEnd||''),!!mode).text;
      if(start.length<6||end.length<6)continue;
      reason='anchor-not-found';
      const from=index.starts.findIndex(offset=>offset>=cursor);
      if(from<0)continue;
      const starts=occurrences(index.text,start,from);
      if(starts.length!==1){if(starts.length)reason='ambiguous-start';continue;}
      const at=starts[0];
      const next=indexedText(String(cases[i+1]?.rawStart||''),!!mode).text;
      const boundary=next.length>=6?index.text.indexOf(next,at+start.length):-1;
      const ends=occurrences(index.text,end,at,boundary<0?index.text.length:boundary).filter(pos=>pos+end.length>=at+start.length);
      if(ends.length!==1){reason=ends.length?'ambiguous-end':'end-not-found';continue;}
      const rawStart=index.starts[at];let rawEnd=index.ends[ends[0]+end.length-1];
      if(mode)while(rawEnd<raw.length&&/\p{P}/u.test(raw[rawEnd]))rawEnd++; 
      cursor=rawEnd;
      return {rawTranscript:raw.slice(rawStart,rawEnd),rawMatchStatus:mode===2?'metadata-normalized':mode?'normalized':'exact',sourceStart:rawStart,sourceEnd:rawEnd};
    }
    // Compatibility for an older model response, only if it is literally present in source.
    const legacy=typeof c.rawTranscript==='string'?c.rawTranscript.trim():'';
    const at=legacy && !(cases.length>1&&legacy===raw.trim())?raw.indexOf(legacy,cursor):-1;
    if(at>=0&&raw.indexOf(legacy,at+1)<0){cursor=at+legacy.length;return {rawTranscript:raw.slice(at,cursor),rawMatchStatus:'legacy-exact',sourceStart:at,sourceEnd:cursor};}
    return {rawTranscript:'',rawMatchStatus:reason};
  });
}

function normalizeStructured(result, raw, title) {
  if(!Array.isArray(result.sections)||!result.sections.length)throw new Error('AI 未返回可用章节，请重试。');
  const transcripts=sliceCaseTranscripts(raw,result.sections);
  const sections=result.sections.map((section,i)=>{
    if(!section||typeof section.title!=='string'||!section.title.trim()||!Array.isArray(section.blocks))throw new Error('AI 返回的章节格式不正确，请重试。');
    const blocks=section.blocks.map(block=>{
      if(!block||!Array.isArray(block.paragraphs)||block.paragraphs.some(p=>typeof p!=='string'))throw new Error('AI 返回的章节正文格式不正确，请重试。');
      return {heading:typeof block.heading==='string'?block.heading.trim():'',paragraphs:block.paragraphs.map(p=>p.trim()).filter(Boolean)};
    }).filter(b=>b.paragraphs.length);
    if(!blocks.length)throw new Error('AI 返回了空章节，请重试。');
    const review=(Array.isArray(section.review)?section.review:[]).filter(q=>q&&typeof q.question==='string'&&typeof q.answer==='string'&&q.question.trim()&&q.answer.trim()).map(q=>({question:q.question.trim(),answer:q.answer.trim()}));
    return {title:section.title.trim(),subtitle:'',blocks,review,rawStart:String(section.rawStart||''),rawEnd:String(section.rawEnd||''),...transcripts[i]};
  });
  return {kind:'structured',title:title||String(result.title||'结构化笔记'),summary:String(result.summary||''),sections,cases:[],raw,methods:[],advice:[],core:[],background:[],universal:[],quotes:[],extractionVersion:4,engine:'ai'};
}

export function normalizeNote(result, raw, title) {
  if(result&&(result.kind==='structured'||(!result.cases?.length&&result.sections?.length)))return normalizeStructured(result,raw,title);
  if (
    !result ||
    !Array.isArray(result.cases) ||
    !result.cases.length
  ) {
    throw new Error(
      'AI 未返回可用笔记内容，请重试。'
    );
  }

  const source = raw.replace(/\s/g, '');
  const transcripts=sliceCaseTranscripts(raw,result.cases);

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

    // 放宽数量限制，避免 Prompt 要求详细，
    // 结果又被后端二次裁剪。
    const advice = named(
      c.advice,
      '案例建议',
      20
    );

    const universal = named(
      c.universal,
      '通用建议',
      12
    );

    if (!Array.isArray(c.review)) {
      throw new Error(
        'AI 返回的复习问答格式不正确。'
      );
    }

    const review = c.review
      .slice(0, 12)
      .map(q => {
        if (
          !q ||
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

    const {rawTranscript,...sourceMatch}=transcripts[index];

    return {
      id: index + 1,

      title:
        c.title.trim(),

      subtitle:
        c.subtitle.trim(),

      kicker:
        String(c.kicker || '')
          .slice(0, 16),

      background:
        strings(
          c.background,
          '背景',
          20
        ),

      core:
        strings(
          c.core,
          '核心问题',
          12
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
          20
        ).filter(q =>
          source.includes(
            q.replace(/\s/g, '')
          )
        ),

      methods:
        universal.map(v => v.text),

      review,

      rawStart:String(c.rawStart||''),
      rawEnd:String(c.rawEnd||''),
      ...sourceMatch,
      rawTranscript,

      // 同时兼容旧前端可能读取 raw 的逻辑
      raw: rawTranscript,

      expertNamed: true
    };
  });

  const methods = named(
    result.methods,
    '底层方法论',
    20
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

    // 整份原始材料仍然保留
    raw,

    extractionVersion: 3,

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
      'AI 输出被截断，请稍后重试。'
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
          : 0,

      anchorCases:
        Array.isArray(
          parsed?.cases
        )
          ? parsed.cases.filter(
              c =>
                typeof c?.rawStart === 'string' && c.rawStart.trim() &&
                typeof c?.rawEnd === 'string' && c.rawEnd.trim()
            ).length
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
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        res.end(await readFile(path.join(root,'index.html')));

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

      // A random job token is also the idempotency key. No account identity is inferred.
      if(req.method==='GET' && url.pathname.startsWith('/api/jobs/')){
        pruneJobs();
        const job=jobs.get(url.pathname.slice('/api/jobs/'.length));
        if(!job){send(req,res,404,{error:'任务记录已过期或服务器已重启。已保存的笔记不受影响，请重新上传这份未完成的材料。'});return;}
        send(req,res,200,{status:job.status,stage:job.stage,note:job.note,error:job.error});return;
      }
      if(req.method==='POST' && url.pathname==='/api/jobs'){
        try{
          let size=0;const chunks=[];
          for await(const chunk of req){size+=chunk.length;if(size>1600000)throw new Error('文件太大，请分成几份上传。');chunks.push(chunk);}
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if(!/^[a-f0-9-]{36}$/i.test(body.requestId||''))throw new Error('任务标识无效。');
          if(typeof body.text!=='string'||!body.text.trim()||body.text.length>200000)throw new Error('材料须为 1–200000 字。');
          pruneJobs();
          if(jobs.has(body.requestId)){send(req,res,202,{jobId:body.requestId});return;}
          if(active.size){send(req,res,429,{error:'当前服务正在生成，请稍候。'});return;}
          if(jobs.size>=30){send(req,res,503,{error:'暂存空间已满，请稍后重试。'});return;}
          const controller=new AbortController();active.add(controller);
          const job={status:'running',stage:'AI 正在分析案例与知识结构',createdAt:Date.now()};
          jobs.set(body.requestId,job);
          send(req,res,202,{jobId:body.requestId});
          const timeout=setTimeout(()=>controller.abort(),600000);
          (async()=>{
            try{
              job.note=await generate(body,controller.signal);
              job.status='succeeded';job.stage='笔记已完成';
              console.log('[JOB SUCCESS]',{kind:job.note.kind||'cases',cases:job.note.cases.length,sections:job.note.sections?.length||0,rawTranscriptCases:job.note.cases.filter(c=>c.rawTranscript).length,rawTranscriptSections:job.note.sections?.filter(c=>c.rawTranscript).length||0});
            }catch(e){job.status='failed';job.error=e.name==='AbortError'?'生成超过 10 分钟，请缩短材料后重试。':e.message;}
            finally{job.finishedAt=Date.now();clearTimeout(timeout);active.delete(controller);}
          })();
        }catch(e){send(req,res,400,{error:e.message});}
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
                : 0,

            rawTranscriptCases:
              Array.isArray(
                note.cases
              )
                ? note.cases.filter(
                    c =>
                      typeof c.rawTranscript === 'string' &&
                      c.rawTranscript.trim()
                  ).length
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
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) server.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `SeeUNotes API running on port ${port}`
    );
  }
);

export { server };
