/**
 * Simulate a BUY end-to-end, against real chain data, in seconds.
 *
 * Waiting for a watched wallet to buy is a poor debugging loop — it can be hours, and when it
 * finally happens you get one sample and no control. This replays a REAL historical transaction
 * through the REAL verifier and the REAL lane logic, so "is a buy triggering?" is answerable on
 * demand and repeatably.
 *
 * Nothing is faked silently. Verification is the production LiveTradeVerifier against the
 * production RPC; market cap and pair age come from DexScreener and canSell from GoPlus, and each
 * is printed with its value so a null reads as "genuinely unknown", never as an assumption.
 *
 *   node scripts/simulate-buy.mjs <txHash> <walletAddress> [SYMBOL] [graded]
 *
 * The optional `graded` flag substitutes a wallet WITH a track record and changes nothing else —
 * an A/B control that isolates one input. Measured 2026-08-08 on a real LILY buy:
 *
 *   without: skipped, score 84 — "wallet ungraded (only 0 verified outcome(s); 5 needed)"
 *   with:    MATCH,   score 91 — earliest-entry + proven-wallets
 *
 * which is how we established that the buy path is whole and the wallet grade is the last gate.
 * Run it from the box (or anywhere with dist/ built and the chain reachable).
 */
// Simulate a BUY end-to-end: real tx -> real verifier -> real V2Shadow lane evaluation.
// Nothing is fabricated: every provider prints the value it used and where it came from.
import { LiveTradeVerifier } from "../dist/chain/liveTradeVerifier.js";
import { V2Shadow } from "../dist/v2/runtime.js";
import { Journal } from "../dist/v2/journal.js";
import { config } from "../dist/config/env.js";
import { SEED_WALLETS } from "../dist/data/seed.js";

const TX = process.argv[2];
const WALLET = process.argv[3].toLowerCase();
const R = config.CHAIN_HTTP_URL;
const rpc = async (m,p)=> (await (await fetch(R,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})})).json()).result;

const XFER="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const rc = await rpc("eth_getTransactionReceipt",[TX]);
const blk = await rpc("eth_getBlockByNumber",[rc.blockNumber,false]);
const wtopic="0x"+"0".repeat(24)+WALLET.slice(2);
const log = rc.logs.find(l=>(l.topics[0]||"").toLowerCase()===XFER && (l.topics[2]||"").toLowerCase()===wtopic);
if(!log){ console.log("no incoming transfer to that wallet in this tx"); process.exit(1); }
const token = log.address.toLowerCase();

console.log("=== 1. VERIFY (real LiveTradeVerifier) ===");
const transfer={token,from:"0x"+log.topics[1].slice(26),to:WALLET,rawValue:BigInt(log.data),txHash:TX,blockNumber:Number(rc.blockNumber),logIndex:Number(log.logIndex)};
const verdict = await new LiveTradeVerifier().verify({address:log.address,topics:log.topics,data:log.data,logIndex:log.logIndex}, transfer, WALLET, "BUY");
console.log(JSON.stringify(verdict));
if(!verdict.confirmed){ console.log("\nSTOPS HERE: not a verified buy, v2 would never see it."); process.exit(0); }

console.log("\n=== 2. REAL FACTS (DexScreener + GoPlus) ===");
let cap=null, ageH=null, canSell=null;
try{
  const ds=await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`,{signal:AbortSignal.timeout(15000)})).json();
  const p=(ds.pairs||[]).sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
  if(p){ cap=p.fdv??p.marketCap??null; if(p.pairCreatedAt) ageH=(Date.now()-p.pairCreatedAt)/3600000; }
}catch(e){ console.log("dexscreener failed:", e.message); }
try{
  const g=await (await fetch(`https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${token}`,{signal:AbortSignal.timeout(15000)})).json();
  const r=g.result?.[token]; if(r) canSell = r.cannot_sell_all==="1"||r.is_honeypot==="1" ? false : true;
}catch(e){ console.log("goplus failed:", e.message); }
console.log("marketCap:",cap,"| pairAgeHours:",ageH==null?null:ageH.toFixed(2),"| canSell:",canSell,"  (null = genuinely unknown, NOT assumed)");

console.log("\n=== 3. LANE EVALUATION (real V2Shadow) ===");
process.env.V2_SHADOW_ENABLED="true";
const jrnl=new Journal({path:"",enabled:false,maxSegmentBytes:1,maxTotalBytes:1});
const matches=[];
const shadow=new V2Shadow({
  marketCap:()=>cap, pairAge:()=>ageH==null?null:{hours:ageH,source:"dexscreener-sim"},
  canSell:()=>canSell,
  // The real holder-rank from the seed catalog. Without this every run reported "wallet not in the
  // seed holder catalog" and fresh-entry looked broken when production would have known the tier —
  // a simulator that under-reports is worse than none, because it is believed.
  seedTier:(w)=> SEED_WALLETS.find(x=>x.address.toLowerCase()===w.toLowerCase())?.tier ?? null,
  // CONTROL: a hypothetical wallet with a real grade. Everything else on this run is real chain
  // data. Toggled by argv[5] so the difference between the two runs is exactly one input.
  outcomes:()=> process.argv[5]==="graded" ? [5.2,3.1,1.95,2.8,1.15,3.6,1.08,2.5].map((m,i)=>({
    at: Date.now()-(i+1)*86400000, peakMultiple: m, ruggedAfter:false,
  })) : [],
  claimFirstBuy:()=>true,
}, undefined, jrnl, undefined, (m)=>matches.push(m));
shadow.onSwap({
  txHash:TX, wallet:WALLET, token, tokenSymbol:process.argv[4]||"SIM", direction:"BUY",
  amount:Number(BigInt(log.data))/1e18, usdValue:null,
  blockNumber:Number(rc.blockNumber), logIndex:Number(log.logIndex),
  timestamp:Number(BigInt(blk.timestamp))*1000,
  verifiedTrade:true, verifiedCategory:verdict.category,
});
await new Promise(r=>setTimeout(r,1500));
console.log("MATCHES EMITTED:", matches.length);
for(const m of matches) console.log("  ", JSON.stringify({lanes:m.lanes,score:m.score,reasons:m.laneReasons}));
for(const e of shadow.recent(5)){
  console.log("  outcome:", e.outcome, "| score:", e.score, "| reason:", e.reason);
  if(e.matchedLanes?.length) console.log("  matched lanes:", e.matchedLanes.join(", "));
  for(const l of (e.lanes||e.laneResults||[])){
    console.log("   lane", (l.laneId||l.id||"?").padEnd(16), l.matched?"MATCH":"no", "->", l.reason||"");
  }
  if(e.nearMiss) console.log("  nearMiss:", JSON.stringify(e.nearMiss));
}
shadow.stop();
