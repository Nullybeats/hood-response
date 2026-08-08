/**
 * The prior call record, imported from cipherfi's all-time archive on 2026-08-08.
 *
 * WHY THIS EXISTS. A wallet grades `U` until it has 5 measured outcomes, and the v2 ledger only
 * started recording hours ago — so wallets with a long, genuinely good record read as unproven,
 * and the best performers on the benchmark feed were indistinguishable from a wallet we had never
 * seen. These are their real outcomes, so a grade starts from what a wallet has actually done
 * rather than from nothing.
 *
 * A PRIOR, NOT AN OVERRIDE. Seeded outcomes go through the same weighted grading as live ones and
 * carry their real timestamps, so:
 *   - recency weighting decays them (1.0 today → 0.25 at the 45-day edge),
 *   - `STALE_DAYS` still drifts a wallet back to U if it goes quiet,
 *   - and `MAX_OUTCOMES` takes the most recent 20, so LIVE outcomes displace the seed entirely
 *     once a wallet has 20 of its own. Nothing here is permanent, and nothing here can outvote
 *     what a wallet does from now on.
 *
 * BASIS CAVEAT, stated because it matters. These are legacy BUY calls (SOLO/ENTRY/BUY at $26k–$385k
 * caps), while the live basis is ALLOCATIONS. They are different behaviours, and a wallet can be
 * good at one and bad at the other — `b4646927d04acb5a` is alpha rank 1 with a strong buy record
 * and grades F on allocations. That is exactly why this is a decaying, displaceable prior and not
 * a stamped grade: the live record is allowed to overturn it, and for that wallet it already has.
 *
 * EVERY wallet with a record is seeded, not just the winners. Seeding only the good ones would bias
 * every grade upward and quietly turn the scale into a ranking of who we chose to remember.
 *
 * Shape: walletId → [firedAt(ms), peakGainPct, ruggedAfter(0|1)][], newest first, capped at 20.
 */
export const PRIOR_OUTCOMES: Readonly<Record<string, readonly (readonly [number, number, number])[]>> =
  {"90dc9ccc8f1748a5":[[1786169639986,10.7,0],[1786134943070,125.2,0],[1786134229484,44.7,0],[1786052724055,196.7,0],[1785756197888,79.9,0]],"f1b483daa1b9ab9f":[[1786149118202,579.1,0],[1786136768932,101.2,0],[1786134542886,0.0,0],[1786050560250,0.0,0],[1785794320556,187.1,0],[1785739517993,19.1,0]],"4dcf442358fe9884":[[1786141487641,17.9,0],[1786140141529,7.2,0],[1786139617779,0.0,0],[1786139454505,8.4,0],[1785824659917,20.6,0],[1785819222907,131.0,0]],"375958b9ae17ecd7":[[1786140930541,71.1,0],[1786138749883,75.4,0],[1786138039828,17.1,0],[1786138004262,0.0,0],[1786136137572,36.1,0],[1785823505803,189.6,1],[1785789408721,123.7,0],[1785715321061,117.0,0],[1785704531076,237.5,0]],"60ab07cbd3475aef":[[1786064710193,119.5,0]],"7e86554ac405a072":[[1786058325144,21.1,0]],"f25829a96819198b":[[1786039618191,23.5,0],[1786013367126,0.0,0],[1785780479462,130.7,0],[1785681865482,53.6,0],[1785681833437,54.4,0]],"c7021b0d929e24ae":[[1786039618055,23.5,0],[1785967236553,39.5,0]],"2c5af62d6746abef":[[1786016372058,32.7,0]],"d75b1cadc2ca44cb":[[1786013367298,0.0,0]],"ec91d3bc9dc504b5":[[1785977835618,32.8,0],[1785809549197,40.2,0],[1785809533675,167.2,0],[1785768095118,71.0,0]],"6320c924b5118eef":[[1785948477527,50.6,0]],"97bce3db38701ad4":[[1785863235739,123.5,0],[1785791884885,159.0,0],[1785770447492,142.8,1],[1785770447212,115.0,1]],"99d525da294adc18":[[1785863235739,123.5,0],[1785791884885,159.0,0],[1785770447492,142.8,1]],"20baf63ded79d866":[[1785839390972,36.2,0],[1785839240777,27.6,0],[1785817893278,10.7,0],[1785804879671,229.7,0],[1785787919132,224.7,0],[1785691380520,30.7,0],[1785691380470,21.8,0],[1785653653388,68.0,0],[1785653048817,0.0,0],[1785652142799,4.9,0],[1785650528050,55.3,0],[1785650527732,46.8,0],[1785640560845,20.8,0]],"99da21c58e63867f":[[1785839390972,36.2,0],[1785839240777,27.6,0],[1785817893278,10.7,0],[1785804879671,229.7,0],[1785787919132,224.7,0],[1785653653388,68.0,0],[1785652142799,4.9,0],[1785650528050,55.3,0]],"a62a3e7db79ed3d6":[[1785839390972,36.2,0],[1785839362786,0.0,0],[1785778449876,74.1,0],[1785740512432,32.6,0],[1785667424511,167.9,0],[1785667424246,16.4,0]],"bbfe89ebaf8842c6":[[1785839390972,36.2,0],[1785839362786,0.0,0],[1785778449876,74.1,0],[1785740512432,32.6,0],[1785667424511,167.9,0]],"b69d5838a9424de6":[[1785824659917,20.6,0],[1785819222907,131.0,0]],"8fbbb7ce51d47d2b":[[1785823505803,189.6,1],[1785789408721,123.7,0],[1785715321061,117.0,0],[1785704531076,237.5,0]],"535d6186a63e09e3":[[1785811541640,193.7,0]],"5431577649029288":[[1785811541640,193.7,0]],"9a7a5390844ac516":[[1785809549197,40.2,0],[1785809533675,167.2,0],[1785768095118,71.0,0]],"f8d5633af00c42f4":[[1785794320556,187.1,0],[1785739517993,19.1,0]],"128d8213da7d2d15":[[1785783182109,40.8,0]],"4d80fe65e28325a5":[[1785783182109,40.8,0]],"5a4b2c2f5925e009":[[1785783182109,40.8,0]],"7ae1315ef1d53f24":[[1785783182109,40.8,0]],"89b08b140cd5aa69":[[1785780479462,130.7,0],[1785681865482,53.6,0]],"9e9b7f400b753c3d":[[1785771570560,18.6,0]],"fe10d6e9e593904f":[[1785771570560,18.6,0]],"5596aeb072728999":[[1785756205535,97.9,0]],"7a7cf182971dd8fa":[[1785756205535,97.9,0]],"f090692e896de8f4":[[1785756197888,79.9,0]],"2dca00b2a9659fcc":[[1785665705411,228.2,0],[1785665704575,46.5,0]],"4e9c41064a28aa82":[[1785665705411,228.2,0]]} as const;
