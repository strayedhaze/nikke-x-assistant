import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

test('NIKKE NOTE: Chromium functional checks',{timeout:60000},async t=>{
  const html=await readFile(new URL('../index.html',import.meta.url));
  const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const profile=await mkdtemp(join(tmpdir(),'nikke-test-'));
  const browser=spawn(process.env.CHROMIUM_PATH||'chromium',['--headless','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let stderr='',socket,seq=0;
  const pending=new Map();
  browser.stderr.on('data',data=>{stderr+=data;});
  try {
    let port;
    for(let i=0;i<100;i++){
      try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{}
      if(browser.exitCode!==null)throw new Error(`Chromium failed: ${stderr}`);
      await delay(100);
    }
    assert.ok(port,'Chromium debugging port ready');
    const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(targets.find(x=>x.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    socket.onmessage=event=>{
      const m=JSON.parse(event.data),p=pending.get(m.id);
      if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}`));},10000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    const ev=async expression=>{
      const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
    };
    const load=async()=>{
      await send('Page.navigate',{url:origin});
      for(let i=0;i<100;i++){if(await ev("document.readyState==='complete' && !!document.getElementById('share')"))return;await delay(25);}
      throw new Error('Application did not load');
    };
    await send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:1,mobile:true});
    await load();
    if(process.env.NIKKE_SCREENSHOT_PATH){
      const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
      await writeFile(process.env.NIKKE_SCREENSHOT_PATH,Buffer.from(capture.data,'base64'));
    }
    await t.test('initial confirmation gate and mobile layout',async()=>{
      assert.equal(await ev("$('share').disabled && $('compose').disabled && $('copy').disabled"),true);
      assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
      assert.equal(await ev('document.documentElement.lang'),'ja');
    });
    await t.test('all 18 templates and canceled replacement',async()=>{
      const values=await ev(`(()=>{const result=[];window.confirm=()=>true;
        for(const m of ['post','reply'])for(const c of characters)for(const topic of topics){
          setMode(m);$('character').value=c;$('topic').value=topic;changed();$('apply').click();
          result.push({text:$('draft').value,character:c,checked:$('confirmed').checked});
        }
        window.confirm=()=>false;const before=$('draft').value;$('apply').click();result.push(before===$('draft').value);return result;})()`);
      assert.equal(values.length,19);
      for(const v of values.slice(0,18)){assert.ok(v.text.includes(v.character));assert.equal(v.checked,false);}
      assert.equal(new Set(values.slice(0,18).map(v=>v.text)).size,18);assert.equal(values[18],true);
    });
    await t.test('URL validation rejects unsafe or malformed targets',async()=>{
      const r=await ev(`['https://x.com/user/status/123?s=20','https://twitter.com/user/status/123','https://mobile.twitter.com/user/status/123','https://x.com/i/web/status/123','http://x.com/user/status/123','https://x.com.evil.example/user/status/123','javascript:alert(1)','https://evil@x.com/user/status/123','https://x.com/user/status/nope','https://x.com/user/status/123/extra','https://x.com:444/user/status/123','https://x.com/user','https://x.com/user/status/0'].map(parsePostUrl)`);
      for(const v of r.slice(0,4))assert.equal(v,'https://x.com/i/web/status/123');
      for(const v of r.slice(4))assert.equal(v,null);
      assert.equal(await ev(`(()=>{setMode('reply');$('post-url').value='';changed();$('confirmed').checked=true;update();return $('share').disabled && $('open-post').disabled && $('compose').hidden;})()`),true);
      assert.equal(await ev(`(()=>{$('post-url').value='https://x.com/user/status/123';changed();$('confirmed').checked=true;update();return !$('share').disabled && !$('open-post').disabled;})()`),true);
    });
    await t.test('grapheme count and edits reset consent',async()=>{
      assert.equal(await ev("countCharacters('紅蓮👨‍👩‍👧‍👦')"),3);
      assert.equal(await ev(`(()=>{$('confirmed').checked=true;$('draft').value='<script>alert(1)<'+ '/script>';$('draft').dispatchEvent(new Event('input'));return !$('confirmed').checked && $('share').disabled && document.querySelectorAll('script').length===1;})()`),true);
    });
    await t.test('reload restores draft but not consent',async()=>{
      await ev(`$('draft').value='紅蓮の育成メモ';$('post-url').value='https://x.com/user/status/123';changed();$('confirmed').checked=true;update();`);await load();
      assert.deepEqual(await ev("[mode,$('draft').value,$('post-url').value,$('confirmed').checked,$('share').disabled]"),['reply','紅蓮の育成メモ','https://x.com/user/status/123',false,true]);
    });
    await t.test('share passes text only and does not claim publication',async()=>{
      await ev(`Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.shared=data;}});$('confirmed').checked=true;update();$('share').click();`);
      assert.deepEqual(await ev('window.shared'),{text:'紅蓮の育成メモ'});assert.match(await ev("$('status').textContent"),/完了はX上で確認/);
    });
    await t.test('share cancellation and rejection',async()=>{
      await ev(`Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new DOMException('cancel','AbortError');}});$('share').click();`);
      assert.match(await ev("$('status').textContent"),/キャンセル/);
      await ev(`Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new Error('denied');}});$('share').click();`);
      assert.match(await ev("$('status').textContent"),/共有できません/);
    });
    await t.test('unsupported share and canShare=false fall back to clipboard',async()=>{
      await ev(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text;}}});Object.defineProperty(navigator,'share',{configurable:true,value:undefined});update();$('share').click();`);
      assert.equal(await ev('window.copied'),'紅蓮の育成メモ');assert.match(await ev("$('share').textContent"),/コピー/);
      await ev(`window.copied=null;Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new Error('must not share');}});Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});update();$('share').click();`);
      assert.equal(await ev('window.copied'),'紅蓮の育成メモ');
    });
    await t.test('clipboard rejection and absence offer manual copy',async()=>{
      for(const stub of ["{writeText:async()=>{throw new Error('denied');}}",'undefined']){
        await ev(`(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:${stub}});await copyText();})()`);
        assert.match(await ev("$('status').textContent"),/長押し/);
        assert.deepEqual(await ev("[$('draft').selectionStart,$('draft').selectionEnd]"),[0,'紅蓮の育成メモ'.length]);
      }
    });
    await t.test('X opening uses canonical target and encoded compose text',async()=>{
      await ev(`window.open=(...args)=>{window.openArgs=args;return null;};$('open-post').click();`);
      assert.deepEqual(await ev('window.openArgs'),['https://x.com/i/web/status/123','_blank','noopener,noreferrer']);
      await ev(`setMode('post');$('confirmed').checked=true;update();$('compose').click();`);
      assert.equal(await ev('window.openArgs[0]'),'https://x.com/intent/post?text='+encodeURIComponent('紅蓮の育成メモ'));
    });
    await t.test('storage failure and deletion preserve unrelated data',async()=>{
      await ev(`window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new Error('quota');};changed();`);
      assert.match(await ev("$('save-state').textContent"),/保存できません/);
      await ev(`Storage.prototype.setItem=window.originalSet;localStorage.setItem('other-app','keep');window.confirm=()=>true;$('delete').click();`);
      assert.deepEqual(await ev("[$('draft').value,localStorage.getItem(STORAGE_KEY),localStorage.getItem('other-app'),$('share').disabled]"),['',null,'keep',true]);
      for(const width of [360,412,480]){
        await send('Emulation.setDeviceMetricsOverride',{width,height:915,deviceScaleFactor:1,mobile:true});
        assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
      }
    });
    await t.test('malformed storage does not break startup',async()=>{
      await ev("localStorage.setItem(STORAGE_KEY,'{broken')");await load();
      assert.equal(await ev("$('share').disabled"),true);assert.match(await ev("$('save-state').textContent"),/読み込めません/);
    });
  }finally{
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('cleanup'));}
    socket?.close();browser.kill('SIGTERM');
    await new Promise(resolve=>{if(browser.exitCode!==null)resolve();else browser.once('exit',resolve);});
    await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
  }
});
