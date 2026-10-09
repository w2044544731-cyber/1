import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScenePlanner, plannerConfiguration } from '../lib/scene-planner.js';
import { createServer } from '../server.js';
import { createStore } from '../lib/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const env={SCENE_TEXT_API_KEY:'test-scene-key-only'};
const plan={scene:'kitchen',reason:'杯子适合厨房台面',prompt:'Keep the original product intact on a natural kitchen countertop.'};

test('documented chat request returns text plan only and does not send product images',async()=>{
  const planner=createScenePlanner({env,fetchImpl:async(url,options)=>{
    assert.equal(url.href,'https://api.deepseek.com/chat/completions');assert.equal(options.headers.Authorization,'Bearer test-scene-key-only');assert.equal(options.redirect,'error');
    const data=JSON.parse(options.body);assert.equal(data.model,'deepseek-flash');assert.equal(data.stream,false);
    assert.deepEqual(JSON.parse(data.messages[1].content),{title:'杯子',category:'厨房',description:'不锈钢'});
    assert.ok(!options.body.includes('image-secret'));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));
  }});
  const result=await planner.plan({title:'杯子',category:'厨房',description:'不锈钢',sourceImage:'image-secret'});
  assert.equal(result.kind,'text_only');assert.equal(result.scene,'kitchen');assert.equal(planner.configuration().imagesSupported,false);
  assert.ok(!JSON.stringify(result).includes(env.SCENE_TEXT_API_KEY));
});
test('unconfigured service, malformed plans, authorization errors and leaked keys fail safely',async()=>{
  assert.equal(plannerConfiguration({}).configured,false);
  assert.equal(plannerConfiguration({...env,SCENE_TEXT_BASE_URL:'http://example.com'}).configured,false);
  await assert.rejects(createScenePlanner({env:{},fetchImpl:()=>{throw new Error('Must not call')}}).plan({title:'杯子'}),error=>error.status===501);
  for(const fetchImpl of [async()=>{throw new Error(env.SCENE_TEXT_API_KEY)},async()=>new Response(env.SCENE_TEXT_API_KEY,{status:401}),async()=>new Response(JSON.stringify({choices:[{message:{content:'invalid JSON'}}]})),async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...plan,prompt:env.SCENE_TEXT_API_KEY})}}]}))]) {
    await assert.rejects(createScenePlanner({env,fetchImpl}).plan({title:'杯子'}),error=>error.status===502&&!error.message.includes(env.SCENE_TEXT_API_KEY));
  }
});
test('HTTP scene plan can be saved without image or product auto-modification',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'scene-plan-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const server=createServer({dataDir:dir,sceneEnv:env,sceneFetch:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}))});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await fetch(`http://127.0.0.1:${server.address().port}/api/scene/plan`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'杯子'})});assert.equal(result.status,200);
  const generated=await result.json();const store=createStore(dir);assert.equal((await store.list()).products.length,0);
  const [product]=await store.import([{title:'杯子',scenePlan:generated}]);assert.equal(product.processedImage,'');
  assert.equal((await store.list()).products[0].scenePlan.prompt,plan.prompt);
  await store.update(product.id,{revision:1,title:'其他商品'});assert.equal((await store.list()).products[0].scenePlan,null);
});
