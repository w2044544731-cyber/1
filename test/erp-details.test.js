import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDetailsReader, detailsPayload, normalizeDetails, DETAILS_PATH } from '../lib/erp-details.js';
import { createStore } from '../lib/store.js';
import { createServer } from '../server.js';
const request = { shopId: 12, detailId: 34 };
const env = { ERP_API_BASE_URL: 'https://erp.example.test', ERP_COOKIE: 'test-cookie', ERP_TIMER_TOKEN: 'test-token', ERP_READ_SUCCESS_CODE: 'OK' };
const response = { result:'success',code:'OK',data:{editModel:'shop',shopCollectItemInfo:{title:'保温杯',itemNum:'CUP',detailId:'34',shopId:'12',site:'US',cid:'567',currency:'USD',outerGoodsUrl:'https://www.temu.com/example.html',imgUrls:['https://example.com/main.png','https://example.com/other.png'],skuMap:{blue:{itemNum:'CUP-B',price:25,stock:10,weight:150},red:{itemNum:'CUP-R',price:26,stock:20,weight:150}},attributes:[{pid:10,values:[{name:'不锈钢'}]}],saleAttributes:[{name:'颜色',values:[{name:'蓝色',imgUrls:['https://example.com/blue.png']}]}],sizeCharts:[{sizeTemplateId:'SIZE-1'}],outerPackageImgUrls:['https://example.com/package.png'],goodsLayerDecorationReqs:[{type:'text',content:{text:'保温杯描述'}}],futureField:{preserved:true}}}};
async function directory(t){const dir=await mkdtemp(path.join(os.tmpdir(),'erp-details-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('details mapping preserves full SKU/attributes snapshot and never flattens multi-SKU prices',()=>{
  const product=normalizeDetails(response,request);
  assert.equal(product.title,'保温杯');assert.equal(product.price,null);assert.equal(product.stock,null);
  assert.equal(product.erpSource.skuCount,2);assert.equal(product.erpSource.site,'US');
  assert.deepEqual(product.erpSource.snapshot,response.data.shopCollectItemInfo);
  assert.equal(product.erpSource.snapshot.futureField.preserved,true);
  assert.equal(product.erpSource.origin,'offline_response');
  assert.equal(product.sourceImage,'https://example.com/main.png');
  const single=structuredClone(response);delete single.data.shopCollectItemInfo.skuMap.red;
  const mapped=normalizeDetails(single,request);assert.equal(mapped.price,25);assert.equal(mapped.currency,'CNY');
  assert.throws(()=>normalizeDetails(response,{...request,detailId:99}),/不一致/);
  assert.throws(()=>detailsPayload({...request,cid:999}),/不切换类目/);
  assert.throws(()=>detailsPayload(null),/detailId/);
});
test('reader uses exact contract, strict success, does not leak secrets and rejects failures',async()=>{
  let calls=0;
  const reader=createDetailsReader({env,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url.pathname,DETAILS_PATH);assert.equal(url.searchParams.get('timerToken'),env.ERP_TIMER_TOKEN);
    assert.equal(options.headers.Cookie,env.ERP_COOKIE);assert.deepEqual(JSON.parse(options.body),request);assert.equal(options.redirect,'error');
    return new Response(JSON.stringify(response));
  }});
  assert.equal(reader.configuration().configured,true);
  assert.equal((await reader.read(request)).erpSource.origin,'live_read');assert.equal(calls,1);
  const failing=createDetailsReader({env,fetchImpl:async()=>{throw new Error(env.ERP_TIMER_TOKEN)}});
  await assert.rejects(failing.read(request),error=>error.status===502&&!error.message.includes(env.ERP_TIMER_TOKEN));
  const bad=createDetailsReader({env,fetchImpl:async()=>new Response(JSON.stringify({...response,code:'WRONG'}))});
  await assert.rejects(bad.read(request),/成功条件/);
  await assert.rejects(createDetailsReader({env:{}}).read(request),error=>error.status===501);
  const sensitive=structuredClone(response);sensitive.data.shopCollectItemInfo.cookie='secret';assert.throws(()=>normalizeDetails(sensitive,request),/授权字段/);
});
test('ERP import preserves snapshot through edits and rejects overwriting existing work',async t=>{
  const store=createStore(await directory(t));const product=await store.importErp(normalizeDetails(response,request));
  await store.update(product.id,{revision:1,title:'新的本地标题'});
  assert.deepEqual((await store.list()).products[0].erpSource.snapshot,response.data.shopCollectItemInfo);
  await assert.rejects(store.importErp(normalizeDetails(response,request)),error=>error.status===409);
  assert.equal((await store.list()).products[0].title,'新的本地标题');
});
test('HTTP supports offline response and configured reading without triggering publication',async t=>{
  let calls=0;
  const server=createServer({dataDir:await directory(t),publishEnv:env,publishFetch:async()=>{calls++;return new Response(JSON.stringify(response));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function post(url,data){const result=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:result.status,data:await result.json()};}
  const imported=await post('/api/erp/details/import',{request,response});assert.equal(imported.status,201);assert.equal(calls,0);
  assert.equal(imported.data.erpSource.origin,'offline_response');
  assert.equal((await post('/api/erp/details/read',request)).status,409);assert.equal(calls,1);
  const state=await(await fetch(base+'/api/state')).json();assert.equal(state.products.length,1);assert.equal(state.publishJobs.length,0);
  const configuration=await(await fetch(base+'/api/integrations')).json();assert.equal(configuration.collection.configured,true);assert.equal(configuration.upload.enabled,false);
  assert.equal((await post('/api/erp/details/import',{response})).status,400);
});
