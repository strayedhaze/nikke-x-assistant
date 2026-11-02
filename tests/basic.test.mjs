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
  const pageRequests=[];
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
      if(m.method==='Network.requestWillBeSent')pageRequests.push(m.params.request.url);
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
      for(let i=0;i<100;i++){if(await ev("document.readyState==='complete' && !!document.getElementById('share')")){
        await ev(`window.launchAttempts=[];window.gptOpens=[];window.open=(...args)=>{gptOpens.push(args);};
          for(const id of gptLaunchIds)$(id).addEventListener('click',event=>{
            window.lastLaunchTrusted=event.isTrusted;
            launchAttempts.push({id,blocked:event.defaultPrevented,href:$(id).getAttribute('href'),target:$(id).getAttribute('target')});
            event.preventDefault(); // Never navigate to external apps or sites in this test harness.
          });`);
        return;
      }await delay(25);}
      throw new Error('Application did not load');
    };
    await send('Network.enable');
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
    await t.test('free topic and custom character are reflected without HTML execution',async()=>{
      await ev(`window.confirm=()=>true;setMode('post');$('custom-character').value='ラピ';$('free-topic').value='今日の育成を振り返りたい <img src=x onerror=alert(1)>';$('free-topic').dispatchEvent(new Event('input'));$('apply').click();`);
      assert.match(await ev("$('draft').value"),/ラピ/);
      assert.match(await ev("$('draft').value"),/今日の育成/);
      assert.equal(await ev("$('preview').querySelector('img')"),null);
    });
    await t.test('three source-based reply tones can be selected and edited',async()=>{
      await ev(`setMode('reply');$('source-text').value='紅蓮で攻略できました！';$('source-text').dispatchEvent(new Event('input'));$('generate-replies').click();`);
      assert.deepEqual(await ev("replyCandidates.map(x=>x[0])"),['自然','丁寧','親しみやすい']);
      assert.equal(await ev("replyCandidates.every(x=>x[1].includes('紅蓮で攻略できました！'))"),true);
      for(const i of [0,1,2]){
        await ev(`$('reply-candidates').querySelectorAll('button')[${i}].click();$('draft').value+=' 自分の感想';changed();`);
        assert.match(await ev("$('draft').value"),/自分の感想/);
        assert.equal(await ev("$('confirmed').checked"),false);
      }
      await ev(`$('source-text').value='別の本文';$('source-text').dispatchEvent(new Event('input'));`);
      assert.equal(await ev("$('reply-candidates').childElementCount"),0);
    });
    await t.test('extended autosave restores source and topic with consent cleared',async()=>{
      await ev(`changed();`);await load();
      assert.deepEqual(await ev("[$('custom-character').value,$('free-topic').value,$('source-text').value,$('confirmed').checked]"),['ラピ','今日の育成を振り返りたい <img src=x onerror=alert(1)>','別の本文',false]);
    });
    await t.test('history save, new entry, reload, edit, overwrite and delete',async()=>{
      await ev(`window.confirm=()=>true;$('save-history').click();$('new-history').click();$('draft').value='二つ目';changed();$('save-history').click();`);
      assert.equal(await ev('historyEntries.length'),2);
      await load();await ev(`window.confirm=()=>true;$('history-list').querySelectorAll('article')[1].querySelector('button').click();`);
      assert.equal(await ev("$('source-text').value"),'別の本文');
      assert.equal(await ev("$('confirmed').checked"),false);
      await ev(`$('draft').value='履歴を修正';changed();$('save-history').click();`);
      assert.deepEqual(await ev('[historyEntries.length,historyEntries[0].text]'),[2,'履歴を修正']);
      await ev(`$('history-list').querySelector('article').querySelectorAll('button')[1].click();`);
      assert.equal(await ev('historyEntries.length'),1);
    });
    await t.test('history quota errors do not delete data; explicit 30 entry limit',async()=>{
      await ev(`window.realSet=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new Error('quota');};$('save-history').click();`);
      assert.match(await ev("$('history-status').textContent"),/保存・削除できません/);
      assert.equal(await ev('historyEntries.length'),1);
      await ev(`Storage.prototype.setItem=window.realSet;window.previousHistory=historyEntries;historyEntries=Array.from({length:30},(_,i)=>({...snapshot(),id:String(i),updatedAt:new Date().toISOString()}));editingHistoryId=null;saveHistory();`);
      assert.match(await ev("$('history-status').textContent"),/30件/);
      await ev('historyEntries=window.previousHistory;renderHistory();');
    });
    await t.test('image file selection previews and validates; files are never persisted',async()=>{
      await ev(`window.pngFile=new File([new Uint8Array([137,80,78,71])],'nikke.png',{type:'image/png'});window.dt=new DataTransfer();dt.items.add(pngFile);$('images').files=dt.files;$('images').dispatchEvent(new Event('change'));`);
      assert.equal(await ev('selectedImages.length'),1);
      assert.equal(await ev("$('image-list').querySelectorAll('img').length"),1);
      assert.equal(await ev("$('confirmed').checked"),false);
      assert.equal(await ev("Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY))).includes('files')"),false);
      await ev(`selectImages(Array(5).fill(pngFile));`);
      assert.equal(await ev('selectedImages.length'),0);
      assert.match(await ev("$('image-status').textContent"),/最大4枚/);
      await ev(`selectImages([new File(['text'],'bad.svg',{type:'image/svg+xml'})]);`);
      assert.equal(await ev('selectedImages.length'),0);
    });
    await t.test('image sharing checks full payload and preserves text share after removal',async()=>{
      await ev(`setMode('post');selectImages([pngFile]);window.shareCalls=[];window.checkedPayloads=[];
        Object.defineProperty(navigator,'canShare',{configurable:true,value:data=>{checkedPayloads.push({text:data.text,files:data.files?.length});return true;}});
        Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{shareCalls.push({text:data.text,files:data.files?.map(f=>f.name)});}});
        $('confirmed').checked=true;update();$('share').click();`);
      assert.deepEqual(await ev('shareCalls[0].files'),['nikke.png']);
      assert.equal(await ev('checkedPayloads[0].files'),1);
      assert.equal(await ev('shareCalls[0].text'),await ev("$('draft').value"));
      assert.equal(await ev("historyEntries.some(e=>'sent' in e || 'posted' in e)"),false);
      await ev(`$('clear-images').click();$('confirmed').checked=true;update();$('share').click();`);
      assert.equal(await ev("Object.hasOwn(shareCalls[1],'files') && shareCalls[1].files!==undefined"),false);
    });
    await t.test('image sharing unsupported, missing capability check, rejection and cancel',async()=>{
      await ev(`selectImages([pngFile]);$('confirmed').checked=true;update();Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});$('share').click();`);
      assert.match(await ev("$('status').textContent"),/手動添付/);
      assert.equal(await ev('shareCalls.length'),2);
      await ev(`Object.defineProperty(navigator,'canShare',{configurable:true,value:undefined});$('share').click();`);
      assert.match(await ev("$('status').textContent"),/手動添付/);
      await ev(`Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new Error('failure');}});$('share').click();`);
      assert.match(await ev("$('status').textContent"),/共有できません.*手動添付/);
      await ev(`Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new DOMException('cancel','AbortError');}});$('share').click();`);
      assert.match(await ev("$('status').textContent"),/キャンセル/);
      await load();assert.equal(await ev('selectedImages.length'),0);
      for(const width of [360,412,480]){
        await send('Emulation.setDeviceMetricsOverride',{width,height:915,deviceScaleFactor:1,mobile:true});
        assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
      }
    });
    await t.test('ChatGPT post prompt contains local context and anti-fabrication guidance',async()=>{
      await ev(`restore({});setMode('post');$('chatgpt-box').open=true;window.gptCopies=[];window.gptOpens=[];
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{gptCopies.push(text);}}});
        window.open=(...args)=>{gptOpens.push(args);};
        $('custom-character').value='紅蓮';$('free-topic').value='今日の育成';$('gpt-notes').value='スキルを1段階上げた';$('gpt-tone').value='polite';$('gpt-generate').click();`);
      const prompt=await ev("$('gpt-prompt').value");
      for(const content of ['紅蓮','今日の育成','スキルを1段階上げた','丁寧で落ち着いた感じ','自然でシンプル','過度な絵文字','ハッシュタグ','宣伝調','未確認のゲーム情報','創作しない'])assert.ok(prompt.includes(content),content);
      assert.deepEqual(await ev('[gptCopies.length,gptOpens.length]'),[0,0]);
      assert.equal(await ev("$('gpt-generate').textContent"),'ChatGPTで投稿文を作成');
      assert.equal(await ev("$('gpt-prompt-box').hidden"),false);
      if(process.env.NIKKE_GPT_SCREENSHOT_PATH){
        const clip=await ev("(()=>{const r=$('chatgpt-box').getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()");
        const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
        await writeFile(process.env.NIKKE_GPT_SCREENSHOT_PATH,Buffer.from(capture.data,'base64'));
      }
    });
    await t.test('ChatGPT launch is blocked before copy and native links activate after copy',async()=>{
      await ev(`$('gpt-open').click();`);
      assert.equal(await ev('launchAttempts.at(-1).blocked'),true);
      assert.match(await ev("$('gpt-status').textContent"),/先にプロンプト/);
      await ev("$('gpt-copy').click();");
      assert.equal(await ev('gptCopies[0]'),await ev("$('gpt-prompt').value"));
      assert.equal(await ev('gptOpens.length'),0);
      assert.equal(await ev('launchAttempts.length'),1); // Copy never initiates navigation.
      await ev("$('gpt-open').click();");
      assert.deepEqual(await ev('launchAttempts.at(-1)'),{id:'gpt-open',blocked:false,href:'https://chatgpt.com/',target:null});
      assert.equal(await ev('gptCopies.length'),1);
    });
    await t.test('ChatGPT copy rejection and absence expose selectable manual text',async()=>{
      for(const stub of ["{writeText:async()=>{throw new Error('denied');}}",'undefined']){
        await ev(`(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:${stub}});await copyGptPrompt();})()`);
        assert.equal(await ev("$('gpt-prompt-box').hidden"),false);
        assert.match(await ev("$('gpt-status').textContent"),/長押し/);
        assert.equal(await ev("$('gpt-open').getAttribute('aria-disabled')"),'true');
        assert.equal(await ev("$('gpt-manual-copy-box').hidden"),false);
        assert.equal(await ev("$('gpt-prompt').selectionEnd"),await ev("$('gpt-prompt').value.length"));
      }
    });
    await t.test('ChatGPT reply requires source and purpose, uses requested tone, and excludes URL',async()=>{
      await ev(`setMode('reply');$('gpt-generate').click();`);
      assert.equal(await ev("$('gpt-prompt').value"),'');
      assert.match(await ev("$('gpt-status').textContent"),/本文と返信目的/);
      await ev(`$('source-text').value='スノーホワイトで挑戦中';$('gpt-purpose').value='編成について質問';$('gpt-tone').value='friendly';$('post-url').value='https://x.com/user/status/987';$('gpt-generate').click();`);
      const prompt=await ev("$('gpt-prompt').value");
      for(const content of ['返信案を3種類','スノーホワイトで挑戦中','編成について質問','親しみやすく'])assert.ok(prompt.includes(content));
      assert.ok(!prompt.includes('https://x.com/'));
      assert.equal(await ev("$('gpt-generate').textContent"),'ChatGPTで返信案を作成');
      assert.equal(await ev("$('gpt-reply-fields').hidden"),false);
    });
    await t.test('prompt inputs invalidate old prompt; mode and history restore clear it',async()=>{
      for(const [id,event] of [['gpt-notes','input'],['gpt-purpose','input'],['source-text','input'],['free-topic','input'],['custom-character','input'],['character','change'],['topic','change'],['gpt-tone','change']]){
        await ev(`$('gpt-generate').click();$('${id}').dispatchEvent(new Event('${event}'));`);
        assert.equal(await ev("$('gpt-copy').disabled && $('gpt-prompt-box').hidden"),true,id);
      }
      await ev(`$('gpt-generate').click();setMode('post');`);
      assert.equal(await ev("$('gpt-prompt').value"),'');
    });
    await t.test('pasted answer requires explicit apply, preserves images, resets consent and saves',async()=>{
      await ev(`window.confirm=()=>true;selectImages([new File(['png'],'answer.png',{type:'image/png'})]);$('draft').value='元の本文';$('confirmed').checked=true;update();$('gpt-answer').value='育成を少し進めました。';$('gpt-answer').dispatchEvent(new Event('input'));`);
      assert.equal(await ev("$('draft').value"),'元の本文');
      assert.equal(await ev("$('confirmed').checked"),true);
      await ev("$('gpt-apply').click();");
      assert.deepEqual(await ev("[$('draft').value,$('confirmed').checked,$('share').disabled,selectedImages.length]"),['育成を少し進めました。',false,true,1]);
      assert.equal(await ev("JSON.parse(localStorage.getItem(STORAGE_KEY)).text"),'育成を少し進めました。');
      await ev(`$('confirmed').checked=true;update();window.confirm=()=>false;$('gpt-answer').value='置換キャンセル';$('gpt-apply').click();`);
      assert.deepEqual(await ev("[$('draft').value,$('confirmed').checked]"),['育成を少し進めました。',true]);
      await ev(`$('gpt-answer').value='';$('gpt-answer').dispatchEvent(new Event('input'));`);
      assert.equal(await ev("$('gpt-apply').disabled"),true);
      await ev(`$('gpt-answer').value='a'.repeat(10001);applyGptAnswer();`);
      assert.match(await ev("$('gpt-status').textContent"),/10,000/);
    });
    await t.test('ChatGPT fields survive reload and history; legacy defaults and deletion stay safe',async()=>{
      await ev(`window.confirm=()=>true;$('gpt-answer').value='保存する回答';$('gpt-answer').dispatchEvent(new Event('input'));save();`);
      await load();
      assert.deepEqual(await ev("[$('gpt-notes').value,$('gpt-purpose').value,$('gpt-tone').value,$('gpt-answer').value,$('confirmed').checked]"),['スキルを1段階上げた','編成について質問','friendly','保存する回答',false]);
      await ev(`window.confirm=()=>true;$('new-history').click();$('save-history').click();$('gpt-notes').value='別の情報';$('history-list').querySelector('button').click();`);
      assert.equal(await ev("$('gpt-notes').value"),'スキルを1段階上げた');
      assert.equal(await ev("$('gpt-copy').disabled"),true);
      await ev(`$('delete').click();`);
      assert.deepEqual(await ev("[$('gpt-notes').value,$('gpt-answer').value,$('gpt-tone').value]"),['','','natural']);
      for(const width of [360,412,480]){
        await send('Emulation.setDeviceMetricsOverride',{width,height:915,deviceScaleFactor:1,mobile:true});
        assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
      }
    });
    await t.test('Android intent targets official package with a fixed safe web fallback',async()=>{
      await ev(`setMode('post');$('gpt-generate').click();Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});$('gpt-copy').click();`);
      const href=await ev("$('gpt-open-app').getAttribute('href')");
      assert.equal(href,'intent://chatgpt.com/#Intent;scheme=https;package=com.openai.chatgpt;S.browser_fallback_url=https%3A%2F%2Fchatgpt.com%2F;end');
      assert.equal(decodeURIComponent(href.match(/S.browser_fallback_url=([^;]+)/)[1]),'https://chatgpt.com/');
      await ev("$('gpt-open-app').click();");
      assert.equal(await ev('launchAttempts.at(-1).blocked'),false);
      assert.equal(await ev('launchAttempts.at(-1).target'),null); // Same-tab native intent, no popup.
      assert.match(await ev("$('gpt-status').textContent"),/起動を試みます/);
      assert.equal(await ev('gptOpens.length'),0);
    });
    await t.test('browser backup stays available after copy and never contains prompt data',async()=>{
      await send('Emulation.setTouchEmulationEnabled',{enabled:true});
      const point=await ev("(()=>{$('chatgpt-box').open=true;$('gpt-open-web').scrollIntoView({block:'center'});const r=$('gpt-open-web').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
      await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      for(let i=0;i<20;i++){if(await ev("launchAttempts.at(-1)?.id==='gpt-open-web'"))break;await delay(25);}
      assert.equal(await ev('window.lastLaunchTrusted'),true);
      assert.deepEqual(await ev('launchAttempts.at(-1)'),{id:'gpt-open-web',blocked:false,href:'https://chatgpt.com/',target:'_blank'});
      assert.match(await ev("$('gpt-open-web').rel"),/noopener/);
      assert.match(await ev("$('gpt-open-web').rel"),/noreferrer/);
      assert.equal(await ev("gptLaunchIds.every(id=>!$(id).href.includes('text=') && !$(id).href.includes('prompt='))"),true);
    });
    await t.test('manual copy confirmation enables launch; regeneration, mode and reload clear it',async()=>{
      await ev(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});$('gpt-copy').click();`);
      assert.equal(await ev("$('gpt-open-app').getAttribute('aria-disabled')"),'true');
      await ev(`$('gpt-manual-copy').checked=true;$('gpt-manual-copy').dispatchEvent(new Event('change'));`);
      assert.equal(await ev("$('gpt-open-app').getAttribute('aria-disabled')"),'false');
      await ev(`$('gpt-manual-copy').checked=false;$('gpt-manual-copy').dispatchEvent(new Event('change'));`);
      assert.equal(await ev("$('gpt-open-app').tabIndex"),-1);
      await ev(`$('gpt-manual-copy').checked=true;$('gpt-manual-copy').dispatchEvent(new Event('change'));$('gpt-generate').click();`);
      assert.equal(await ev("$('gpt-open').getAttribute('aria-disabled')"),'true');
      await ev(`setMode('reply');`);
      assert.equal(await ev("$('gpt-manual-copy').checked"),false);
      await load();
      assert.equal(await ev("gptLaunchIds.every(id=>$(id).getAttribute('aria-disabled')==='true')"),true);
    });
    await t.test('late clipboard results cannot enable a changed prompt or trigger navigation',async()=>{
      for(const success of [true,false]){
        await ev(`setMode('post');$('gpt-generate').click();window.lateResolve=null;window.lateReject=null;
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise((resolve,reject)=>{lateResolve=resolve;lateReject=reject;})}});
          window.pendingGptCopy=copyGptPrompt();$('gpt-notes').value+='更新';$('gpt-notes').dispatchEvent(new Event('input'));$('gpt-generate').click();`);
        await ev(`(async()=>{${success ? 'lateResolve()' : "lateReject(new Error('late failure'))"};await pendingGptCopy;})()`);
        assert.equal(await ev("$('gpt-open').getAttribute('aria-disabled')"),'true');
        assert.equal(await ev("$('gpt-manual-copy-box').hidden"),true);
      }
      assert.equal(await ev('gptReadyToOpen'),false);
      for(const width of [360,412,480]){
        await send('Emulation.setDeviceMetricsOverride',{width,height:915,deviceScaleFactor:1,mobile:true});
        assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
      }
    });
    await t.test('no automatic external page requests during editing and ChatGPT preparation',async()=>{
      assert.ok(pageRequests.length>0);
      assert.deepEqual(pageRequests.filter(url=>/^https?:/.test(url) && !url.startsWith(origin+'/')),[]);
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
