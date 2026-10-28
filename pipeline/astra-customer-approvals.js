import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { canonicalJson, sha256 } from './astra-ledger.js';
import { AstraTenantContextError } from './astra-tenant-context.js';

const fail=(m,s=400,c='customer_approval_invalid')=>{throw new AstraTenantContextError(m,s,c);};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashBytes=b=>createHash('sha256').update(b).digest('hex');
function only(input,keys){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))fail('Unsupported customer approval fields were supplied.');}
const uuid=x=>{if(typeof x!=='string'||!UUID.test(x))fail('A valid UUID is required.');return x.toLowerCase();};
const role=a=>a?.tenantRole||a?.role;
function actorCheck(actor,tenantId,roles){if(!actor?.tenantId||String(actor.tenantId).toLowerCase()!==String(tenantId).toLowerCase())fail('Verified tenant membership is required.',403,'tenant_membership_required');if(!roles.includes(role(actor)))fail('Tenant role does not allow this customer approval action.',403,'tenant_role_forbidden');if(!/^[1-9][0-9]{0,39}$/.test(String(actor.userId||'')))fail('A verified authenticated user is required.',401,'authenticated_user_required');}
function boundedEvidence(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Identity and rights evidence is required.');
  const keys=Object.keys(input);if(keys.some(k=>!['identity','rights'].includes(k))||!input.identity||!input.rights)fail('Identity and rights evidence are both required.');
  const parse=(value,label)=>{let bytes;if(typeof value==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)){bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)fail(`${label} evidence encoding is not canonical base64.`);}else if(value instanceof Uint8Array)bytes=Buffer.from(value);else fail(`${label} evidence must be base64-encoded bytes.`);if(!bytes.length||bytes.length>65536)fail(`${label} evidence must be 1 to 65536 bytes.`);return hashBytes(bytes);};
  return {identitySha256:parse(input.identity,'Identity'),rightsSha256:parse(input.rights,'Rights')};
}
function publicKey(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['pem','derBase64'].includes(k))||Number(Object.hasOwn(input,'pem'))+Number(Object.hasOwn(input,'derBase64'))!==1)fail('Provide exactly one Ed25519 public key PEM or DER value.');
  let key;
  try{
    if(typeof input.pem==='string'&&Buffer.byteLength(input.pem,'utf8')<=4096&&!input.pem.includes('PRIVATE KEY'))key=createPublicKey(input.pem);
    else if(typeof input.derBase64==='string'&&input.derBase64.length<=256&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.derBase64)){const der=Buffer.from(input.derBase64,'base64');if(der.toString('base64')!==input.derBase64||!der.length||der.length>128)fail('Public key bytes are outside the supported size or encoding.');key=createPublicKey({key:der,format:'der',type:'spki'});}
    else fail('Public key encoding is invalid or too large.');
  }catch(e){if(e instanceof AstraTenantContextError)throw e;fail('Public key could not be parsed.');}
  if(key.asymmetricKeyType!=='ed25519')fail('Only Ed25519 public keys are supported.');
  const der=key.export({format:'der',type:'spki'});return {pem:key.export({format:'pem',type:'spki'}).toString(),fingerprintSha256:hashBytes(der)};
}
function decodeSignature(value){if(typeof value!=='string'||value.length!==88||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('Detached signature must be bounded base64 bytes.');const b=Buffer.from(value,'base64');if(b.length!==64||b.toString('base64')!==value)fail('Ed25519 detached signatures must be canonical 64-byte base64.');return b;}
const CHALLENGE_KEYS=['protocol','tenantId','accountId','projectId','caseStudyId','caseStudyVersion','caseStudyContentSha256','caseStudyContent','customerKeyId','purpose','action','issuedAt','expiresAt','nonce'];
function validatedFrozenChallenge(row){
  const bytes=Buffer.from(row.challenge_bytes,'utf8');
  if(hashBytes(bytes)!==String(row.challenge_sha256).trim())fail('Stored challenge bytes failed integrity validation.',409,'customer_challenge_corrupt');
  let frozen;try{frozen=JSON.parse(bytes.toString('utf8'));}catch{fail('Stored challenge bytes are not valid canonical JSON.',409,'customer_challenge_corrupt');}
  if(!frozen||typeof frozen!=='object'||Array.isArray(frozen)||Object.keys(frozen).length!==CHALLENGE_KEYS.length||CHALLENGE_KEYS.some(key=>!Object.hasOwn(frozen,key))||canonicalJson(frozen)!==bytes.toString('utf8'))fail('Stored challenge bytes are not a canonical approval challenge.',409,'customer_challenge_corrupt');
  const uuidMatches=(value,expected)=>typeof value==='string'&&value.toLowerCase()===String(expected).toLowerCase();
  const dateMatches=(value,expected)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).valueOf()===new Date(expected).valueOf();
  const hash=typeof frozen.caseStudyContentSha256==='string'?frozen.caseStudyContentSha256:'';
  if(frozen.protocol!=='astra-customer-case-approval/1'||!uuidMatches(frozen.tenantId,row.tenant_id)||!uuidMatches(frozen.accountId,row.account_id)||!uuidMatches(frozen.projectId,row.project_id)||!uuidMatches(frozen.caseStudyId,row.case_study_id)||Number(frozen.caseStudyVersion)!==Number(row.case_study_version)||!uuidMatches(frozen.customerKeyId,row.customer_key_id)||frozen.purpose!==row.purpose||frozen.action!==row.action||!dateMatches(frozen.issuedAt,row.issued_at)||!dateMatches(frozen.expiresAt,row.expires_at)||frozen.nonce!==row.nonce||!/^[a-f0-9]{64}$/.test(hash)||sha256(canonicalJson(frozen.caseStudyContent))!==hash)fail('Stored challenge bindings failed integrity validation.',409,'customer_challenge_corrupt');
  return {bytes,frozen};
}

/** Owner/admin enrollment is pending until a different authenticated reviewer confirms it. Raw evidence is hashed and discarded. */
export async function enrollAstraCustomerApprovalKey(db,actor,{projectId,publicKey:inputKey,identityRightsEvidence}={}){
  only(arguments[2],['projectId','publicKey','identityRightsEvidence']);
  const project=uuid(projectId);actorCheck(actor,actor.tenantId,['owner','admin']);
  const ev=boundedEvidence(identityRightsEvidence),key=publicKey(inputKey);
  const p=await db.query('SELECT account_id FROM astra.post_sale_projects WHERE tenant_id=$1::uuid AND id=$2::uuid',[actor.tenantId,project]);if(!p.rowCount)fail('Post-sale project not found.',404,'postsale_project_not_found');
  const id=randomUUID();await db.query(`INSERT INTO astra.customer_approval_keys(tenant_id,id,project_id,account_id,public_key_pem,key_fingerprint_sha256,identity_evidence_sha256,rights_evidence_sha256,identity_basis,enrolled_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,'human_reviewed',$9)`,[actor.tenantId,id,project,p.rows[0].account_id,key.pem,key.fingerprintSha256,ev.identitySha256,ev.rightsSha256,String(actor.userId)]);
  return {id,projectId:project,accountId:p.rows[0].account_id,keyFingerprintSha256:key.fingerprintSha256,identityEvidenceSha256:ev.identitySha256,rightsEvidenceSha256:ev.rightsSha256,identityBasis:'human_reviewed',state:'pending_reviewer_confirmation',enrolledBy:String(actor.userId)};
}

/** Only a verified reviewer can confirm; the enrolling user cannot review their own key. */
export async function confirmAstraCustomerApprovalKey(db,actor,keyId){
  const id=uuid(keyId);actorCheck(actor,actor.tenantId,['reviewer']);
  const r=await db.query(`UPDATE astra.customer_approval_keys SET confirmed_by=$3,confirmed_at=clock_timestamp()
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND confirmed_at IS NULL AND revoked_at IS NULL AND enrolled_by<>$3
    RETURNING id,project_id AS "projectId",account_id AS "accountId",key_fingerprint_sha256 AS "keyFingerprintSha256",identity_basis AS "identityBasis",confirmed_at AS "confirmedAt"`,[actor.tenantId,id,String(actor.userId)]);
  if(!r.rowCount)fail('Pending key was not found, was revoked, or requires a different independent reviewer.',409,'customer_key_review_unavailable');
  return {...r.rows[0],state:'confirmed'};
}

export async function revokeAstraCustomerApprovalKey(db,actor,keyId,{reason}={}){
  const id=uuid(keyId);actorCheck(actor,actor.tenantId,['owner','admin']);if(typeof reason!=='string'||!reason.trim()||reason.trim().length>500)fail('A bounded revocation reason is required.');
  const r=await db.query(`UPDATE astra.customer_approval_keys SET revoked_at=clock_timestamp(),revoked_by=$3,revocation_reason=$4
    WHERE tenant_id=$1::uuid AND id=$2::uuid AND revoked_at IS NULL RETURNING id,project_id AS "projectId",revoked_at AS "revokedAt",revoked_by AS "revokedBy",revocation_reason AS reason`,[actor.tenantId,id,String(actor.userId),reason.trim()]);
  if(!r.rowCount){const exists=await db.query('SELECT id,revoked_at FROM astra.customer_approval_keys WHERE tenant_id=$1::uuid AND id=$2::uuid',[actor.tenantId,id]);if(!exists.rowCount)fail('Customer key not found.',404,'customer_key_not_found');return {id,revoked:false,revokedAt:exists.rows[0].revoked_at};}
  return {...r.rows[0],revoked:true};
}

export async function revokeAstraCustomerProjectConsent(db,actor,projectId,{reason}={}){
  const project=uuid(projectId);actorCheck(actor,actor.tenantId,['owner','admin']);if(typeof reason!=='string'||!reason.trim()||reason.trim().length>500)fail('A bounded revocation reason is required.');
  const exists=await db.query('SELECT id FROM astra.post_sale_projects WHERE tenant_id=$1::uuid AND id=$2::uuid',[actor.tenantId,project]);if(!exists.rowCount)fail('Post-sale project not found.',404,'postsale_project_not_found');
  const id=randomUUID();const r=await db.query(`INSERT INTO astra.customer_approval_project_revocations(tenant_id,id,project_id,revoked_by,reason) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5) ON CONFLICT(tenant_id,project_id) DO NOTHING RETURNING id,project_id AS "projectId",revoked_by AS "revokedBy",reason,revoked_at AS "revokedAt"`,[actor.tenantId,id,project,String(actor.userId),reason.trim()]);
  if(r.rowCount)return {...r.rows[0],revoked:true};const old=await db.query('SELECT id,project_id AS "projectId",revoked_by AS "revokedBy",reason,revoked_at AS "revokedAt" FROM astra.customer_approval_project_revocations WHERE tenant_id=$1::uuid AND project_id=$2::uuid',[actor.tenantId,project]);return {...old.rows[0],revoked:false};
}

/** Freeze a canonical, exact case-study payload into a random one-use offline-signing challenge. */
export async function createAstraCustomerApprovalChallenge(db,actor,{caseStudyId,customerKeyId,action,expiresInSeconds=900}={}){
  only(arguments[2],['caseStudyId','customerKeyId','action','expiresInSeconds']);
  actorCheck(actor,actor.tenantId,['owner','admin','operator']);const caseId=uuid(caseStudyId),keyId=uuid(customerKeyId);
  if(!['approve','reject'].includes(action))fail('Signed action must be approve or reject.');if(!Number.isInteger(expiresInSeconds)||expiresInSeconds<60||expiresInSeconds>1800)fail('Challenge lifetime must be 60 to 1800 seconds.');
  const q=await db.query(`SELECT c.id,c.project_id AS "projectId",c.version,c.content,c.content_sha256 AS "contentHash",p.account_id AS "accountId",p.status AS "projectStatus",
    EXISTS(SELECT 1 FROM astra.customer_approval_project_revocations pr WHERE pr.tenant_id=p.tenant_id AND pr.project_id=p.id) AS "consentRevoked"
    FROM astra.post_sale_case_studies c JOIN astra.post_sale_projects p ON(p.tenant_id,p.id)=(c.tenant_id,c.project_id) WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid`,[actor.tenantId,caseId]);
  if(!q.rowCount)fail('Case study not found.',404,'postsale_case_study_not_found');const c=q.rows[0];
  if(c.projectStatus!=='active'||c.consentRevoked)fail('Customer consent is unavailable for this project.',409,'customer_consent_revoked');
  if(sha256(canonicalJson(c.content))!==String(c.contentHash).trim())fail('Case-study content changed after it was versioned.',409,'postsale_case_version_changed');
  const k=await db.query(`SELECT id FROM astra.customer_approval_keys WHERE tenant_id=$1::uuid AND id=$2::uuid AND project_id=$3::uuid AND account_id=$4::uuid AND confirmed_at IS NOT NULL AND revoked_at IS NULL`,[actor.tenantId,keyId,c.projectId,c.accountId]);if(!k.rowCount)fail('A confirmed, active customer key bound to this project and account is required.',409,'customer_key_unavailable');
  const issuedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+expiresInSeconds*1000).toISOString(),nonce=randomBytes(32).toString('base64url');
  const challenge={protocol:'astra-customer-case-approval/1',tenantId:String(actor.tenantId).toLowerCase(),accountId:String(c.accountId),projectId:String(c.projectId),caseStudyId:String(c.id),caseStudyVersion:Number(c.version),caseStudyContentSha256:String(c.contentHash).trim(),caseStudyContent:c.content,customerKeyId:keyId,purpose:'case_study_customer_consent',action,issuedAt,expiresAt,nonce};
  const bytes=Buffer.from(canonicalJson(challenge),'utf8'),id=randomUUID();
  await db.query(`INSERT INTO astra.customer_approval_challenges(tenant_id,id,project_id,account_id,case_study_id,case_study_version,customer_key_id,purpose,action,challenge_bytes,challenge_sha256,nonce,issued_at,expires_at,forwarded_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10,$11,$12,$13,$14,$15)`,[actor.tenantId,id,c.projectId,c.accountId,c.id,c.version,keyId,'case_study_customer_consent',action,bytes.toString('utf8'),hashBytes(bytes),nonce,issuedAt,expiresAt,String(actor.userId)]);
  return {id,challenge:bytes.toString('utf8'),challengeSha256:hashBytes(bytes),expiresAt,signatureFormat:'base64-ed25519-64-byte',privateKeySentToServer:false};
}

/** Verify the customer's detached Ed25519 signature; forwarding actor is recorded separately from signer key. */
export async function submitAstraCustomerApprovalSignature(db,actor,{challengeId,signature}={}){
  only(arguments[2],['challengeId','signature']);
  actorCheck(actor,actor.tenantId,['owner','admin','operator']);const id=uuid(challengeId),sig=decodeSignature(signature),sigHash=hashBytes(sig);
  const q=await db.query(`SELECT ch.*,k.public_key_pem,k.key_fingerprint_sha256,k.confirmed_at,k.revoked_at,k.identity_basis,p.status AS project_status,
    EXISTS(SELECT 1 FROM astra.customer_approval_project_revocations pr WHERE pr.tenant_id=p.tenant_id AND pr.project_id=p.id) AS project_consent_revoked,
    c.version AS current_version,c.content_sha256 AS current_content_hash,c.content AS current_content
    FROM astra.customer_approval_challenges ch JOIN astra.customer_approval_keys k ON(k.tenant_id,k.id)=(ch.tenant_id,ch.customer_key_id)
    JOIN astra.post_sale_projects p ON(p.tenant_id,p.id)=(ch.tenant_id,ch.project_id) JOIN astra.post_sale_case_studies c ON(c.tenant_id,c.id)=(ch.tenant_id,ch.case_study_id)
    WHERE ch.tenant_id=$1::uuid AND ch.id=$2::uuid`,[actor.tenantId,id]);if(!q.rowCount)fail('Approval challenge not found.',404,'customer_challenge_not_found');const ch=q.rows[0];
  const prior=await db.query(`SELECT signature_sha256,action,receipt_id,created_at FROM astra.customer_approval_receipts WHERE tenant_id=$1::uuid AND challenge_id=$2::uuid`,[actor.tenantId,id]);
  if(prior.rowCount){if(prior.rows[0].signature_sha256!==sigHash)fail('Challenge was already consumed by a different proof.',409,'customer_challenge_replayed');return {...prior.rows[0],id:prior.rows[0].receipt_id,duplicate:true,identityBasis:ch.identity_basis,verification:'ed25519_signature_verified_against_human_reviewed_key',signerKeyFingerprintSha256:ch.key_fingerprint_sha256,forwardedBy:String(actor.userId),publishable:false,contactPermission:false};}
  if(ch.revoked_at||!ch.confirmed_at)fail('Customer key is revoked or not independently confirmed.',409,'customer_key_unavailable');if(ch.project_status!=='active'||ch.project_consent_revoked)fail('Project consent was revoked.',409,'customer_consent_revoked');
  if(new Date(ch.expires_at).valueOf()<=Date.now())fail('Approval challenge expired.',409,'customer_challenge_expired');
  const {bytes:challengeBytes,frozen}=validatedFrozenChallenge(ch);
  if(Number(ch.current_version)!==Number(frozen.caseStudyVersion)||String(ch.current_content_hash).trim()!==frozen.caseStudyContentSha256||sha256(canonicalJson(ch.current_content))!==frozen.caseStudyContentSha256)fail('Case-study draft changed after challenge issuance.',409,'postsale_case_version_changed');
  let ok=false;try{ok=verifySignature(null,challengeBytes,createPublicKey(ch.public_key_pem),sig);}catch{}if(!ok)fail('Detached signature does not verify against the enrolled customer key.',403,'customer_signature_invalid');
  const receiptId=randomUUID();
  // Database function atomically claims this challenge and appends the immutable receipt. Caller transaction rolls back on any error.
  const result=await db.query(`SELECT * FROM astra.record_customer_approval_receipt($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11)`,[actor.tenantId,id,receiptId,sigHash,sig.toString('base64'),String(actor.userId),String(ch.customer_key_id),String(ch.project_id),String(ch.case_study_id),String(ch.action),String(ch.challenge_sha256).trim()]);
  const row=result.rows[0];return {id:row.receipt_id,challengeId:id,caseStudyId:ch.case_study_id,projectId:ch.project_id,action:ch.action,createdAt:row.created_at,identityBasis:ch.identity_basis,verification:'ed25519_signature_verified_against_human_reviewed_key',signerKeyFingerprintSha256:ch.key_fingerprint_sha256,forwardedBy:String(actor.userId),signatureSha256:sigHash,publishable:false,contactPermission:false,releaseReady:false};
}

export async function getAstraCustomerApprovalStatus(db,tenantId,caseStudyId){
  const id=uuid(caseStudyId);const q=await db.query(`SELECT c.id,c.project_id AS "projectId",c.version,c.content_sha256 AS "contentHash",p.status AS "projectStatus",
    EXISTS(SELECT 1 FROM astra.customer_approval_project_revocations pr WHERE pr.tenant_id=p.tenant_id AND pr.project_id=p.id) AS "consentRevoked",
    r.receipt_id AS "receiptId",r.action,r.created_at AS "verifiedAt",r.signer_key_id AS "customerKeyId",k.key_fingerprint_sha256 AS "keyFingerprintSha256",k.identity_basis AS "identityBasis",k.revoked_at AS "keyRevokedAt"
    FROM astra.post_sale_case_studies c JOIN astra.post_sale_projects p ON(p.tenant_id,p.id)=(c.tenant_id,c.project_id)
    LEFT JOIN LATERAL(SELECT * FROM astra.customer_approval_receipts x WHERE x.tenant_id=c.tenant_id AND x.case_study_id=c.id ORDER BY x.created_at DESC LIMIT 1) r ON true
    LEFT JOIN astra.customer_approval_keys k ON(k.tenant_id,k.id)=(c.tenant_id,r.signer_key_id) WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid`,[tenantId,id]);
  if(!q.rowCount)fail('Case study not found.',404,'postsale_case_study_not_found');const x=q.rows[0];
  const projectConsentActive=x.projectStatus==='active'&&!x.consentRevoked;
  const state=!projectConsentActive?'revoked':x.receiptId?(x.keyRevokedAt?'revoked':x.action==='approve'?'verified':'rejected'):'pending';
  return {caseStudyId:x.id,projectId:x.projectId,version:x.version,contentHash:String(x.contentHash).trim(),state,verified:state==='verified',identityBasis:x.identityBasis||null,verification:x.receiptId?'ed25519_signature_verified_against_human_reviewed_key':null,receiptId:x.receiptId||null,verifiedAt:x.verifiedAt||null,keyRevoked:Boolean(x.keyRevokedAt),projectConsentActive,publishable:false,contactPermission:false,releaseReady:false};
}
