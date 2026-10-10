import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const directory = mkdtempSync(path.join(tmpdir(), 'odd-website-email-discovery-'));
process.env.ODD_DB_PATH = path.join(directory, 'fixture.db');
process.env.NODE_ENV = 'test';
delete process.env.ODD_AUTH_ENFORCE_TESTS;
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

const { closeDb, initDb } = await import('../pipeline/database.js');
const db = initDb();
const { createWebsiteEmailDiscovery, parseRobotsPolicy, WEBSITE_EMAIL_USER_AGENT } = await import('../pipeline/website-email-discovery.js');
const { setWebsiteEmailDiscoveryTestManager, server } = await import('../server.js');
const { renderLeadDetail } = await import('../js/leads.js');

const batchId = Number(db.prepare("INSERT INTO batches(name,phase,status) VALUES ('Synthetic contacts','discovery','open')").run().lastInsertRowid);
const leadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'North Star Workshop', 'https://northstar.example.com').lastInsertRowid);
const unvisitedRefreshLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Unvisited Refresh Fixture', 'https://unvisited-refresh.example.com').lastInsertRowid);
const blockedLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Robots Restricted Shop', 'https://blocked.example.com').lastInsertRowid);
const failedLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Unavailable Shop', 'https://unavailable.example.com').lastInsertRowid);
const interruptedLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Interrupted Shop', 'https://interrupted.example.com').lastInsertRowid);
const structuredLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,category,address,facebook_url,website_url,status)
  VALUES(?,?,'Operator category','Operator address','https://www.facebook.com/operator-page','https://structured.example.com','discovered')`)
  .run(batchId, 'Operator confirmed name').lastInsertRowid);
const obfuscatedLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Obfuscated Email Shop', 'https://obfuscated.example.com').lastInsertRowid);
const formLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Contact Form Shop', 'https://form-only.example.com').lastInsertRowid);
const hiddenFormLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Hidden Form Shop', 'https://hidden-form.example.com').lastInsertRowid);
const vcardLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'VCard Fixture Business', 'https://vcard.example.com').lastInsertRowid);
const telLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Telephone Fixture Business', 'https://telephone.example.com').lastInsertRowid);
const operatorTelLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,phone,website_url,status)
  VALUES(?,?,'Operator entered phone','https://operator-phone.example.com','discovered')`)
  .run(batchId, 'Operator Phone Business').lastInsertRowid);
const socialLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url,status) VALUES (?,?,?,'discovered')")
  .run(batchId, 'Social Fixture Business', 'https://social.example.com').lastInsertRowid);
const microdataLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,category,website_url,status)
  VALUES(?,?,'Operator category','https://microdata.example.com','discovered')`)
  .run(batchId, 'Microdata Fixture Business').lastInsertRowid);
const hCardLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status)
  VALUES(?,?,'https://hcard.example.com','discovered')`)
  .run(batchId, 'H-Card Fixture Business').lastInsertRowid);
const jsonLdPersonLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status)
  VALUES(?,?,'https://person-jsonld.example.com','discovered')`)
  .run(batchId, 'Person JSON-LD Fixture').lastInsertRowid);
const rdfaLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status)
  VALUES(?,?,'https://rdfa.example.com','discovered')`)
  .run(batchId, 'RDFa Fixture Business').lastInsertRowid);
const metaEmailLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status)
  VALUES(?,?,'https://meta-email.example.com','discovered')`)
  .run(batchId, 'Metadata Email Fixture Business').lastInsertRowid);
const mailtoEndpointLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status)
  VALUES(?,?,'https://mailto-endpoints.example.com','discovered')`)
  .run(batchId, 'Mailto Endpoint Fixture Business').lastInsertRowid);
const accessibleEmailLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status)
  VALUES(?,?,'https://accessible-email.example.com','discovered')`)
  .run(batchId, 'Accessible Email Fixture Business').lastInsertRowid);
const contactAttributeLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,website_url,status)
  VALUES(?,?,'https://contact-attribute.example.com','discovered')`)
  .run(batchId, 'Contact Attribute Fixture Business').lastInsertRowid);
const operatorStructuredPhoneLeadId = Number(db.prepare(`INSERT INTO leads(batch_id,business_name,phone,website_url,status)
  VALUES(?,?,'Operator supplied phone','https://rdfa.example.com','discovered')`)
  .run(batchId, 'RDFa Fixture Business').lastInsertRowid);
db.prepare("INSERT INTO lead_website_email_scans(lead_id,status) VALUES(?,'running')").run(interruptedLeadId);

let mode = 'normal';
let refreshMode = 'original';
let unvisitedRefreshMode = 'original';
let failVcardFallbackOnce = false;
const fetchCalls = [];
let heldRobotsResolve;
let heldRobotsStarted;
const robotsStarted = new Promise(resolve => { heldRobotsStarted = resolve; });
const heldRobots = new Promise(resolve => { heldRobotsResolve = resolve; });

function response(body, status = 200, contentType = 'text/html; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

async function fixtureFetch(input, options = {}) {
  const url = new URL(input);
  fetchCalls.push({ url: url.href, options });
  if (url.pathname === '/robots.txt') {
    if (url.hostname === 'unavailable.example.com') return response('offline', 503, 'text/plain');
    if (url.hostname === 'blocked.example.com') return response('User-agent: *\nDisallow: /', 200, 'text/plain');
    if (url.hostname === 'concurrent.example.com' && mode === 'hold') {
      heldRobotsStarted();
      await heldRobots;
    }
    return response('User-agent: *\nDisallow: /private\nCrawl-delay: 0', 200, 'text/plain');
  }
  if (url.hostname === 'concurrent.example.com') return response('<html><body>No address</body></html>');
  if (url.hostname === 'structured.example.com' && url.pathname === '/') return response(`<html><body>
    <script type="application/ld+json">{
      "@context":"https://schema.org","@type":"Organization","name":"Structured Source Name",
      "industry":"Industrial components","email":"info@structured.example.com","telephone":"+1 212 555 0199",
      "address":{"@type":"PostalAddress","streetAddress":"12 Example Road","addressLocality":"Albany","addressRegion":"New York","postalCode":"12207","addressCountry":{"name":"United States"}},
      "contactPoint":[
        {"@type":"ContactPoint","contactType":"sales","name":"Maya Singh","jobTitle":"Regional Sales Manager","email":"sales@structured.example.com"},
        {"@type":"ContactPoint","contactType":"customer support","email":"support@structured.example.com"}
      ],
      "sameAs":["https://www.facebook.com/structured.example","http://127.0.0.1/admin"]
    }</script>
    <script type="application/ld+json">not valid JSON and must be ignored</script>
  </body></html>`);
  if (url.hostname === 'structured.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'obfuscated.example.com' && url.pathname === '/') {
    return response('<html><body>Sales: sales (at) obfuscated (dot) example. Do not infer support at obfuscated dot example from ordinary prose.</body></html>');
  }
  if (url.hostname === 'obfuscated.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'form-only.example.com' && url.pathname === '/') {
    return response('<html><body><form id="contact-form" action="/contact"><label>Email<input name="email" type="email"></label><label>Message<textarea name="message"></textarea></label><button>Send</button></form></body></html>');
  }
  if (url.hostname === 'hidden-form.example.com' && url.pathname === '/') {
    return response('<html><body><div hidden><form id="contact-form" action="/submit"><input type="email" name="email"><textarea name="message"></textarea></form></div><form aria-hidden="true" class="enquiry-form"><input name="email"></form><form style="display:none" class="contact"><textarea name="message"></textarea></form><form class="public"><input type="hidden" name="contact_email"></form></body></html>');
  }
  if (url.hostname === 'vcard.example.com' && url.pathname === '/') {
    return response('<html><body><a href="/team.vcf">Team contact cards</a><a href="https://other.example.net/contact.vcf">Partner directory</a></body></html>');
  }
  if (url.hostname === 'vcard.example.com' && url.pathname === '/team.vcf') {
    return response(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Nora Shah\r\nORG:VCard Fixture Business\r\nTITLE:Business Development \r\n Lead\r\nURL:https://vcard.example.com\r\nEMAIL;TYPE=WORK:nora@vcard.example.com\r\nEMAIL;TYPE=HOME:nora.personal@gmail.com\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nFN:Unrelated Person\r\nORG:Different Company\r\nEMAIL:other@different.example.net\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nCLASS:PRIVATE\r\nFN:Private Person\r\nORG:VCard Fixture Business\r\nEMAIL;TYPE=WORK:private@vcard.example.com\r\nEND:VCARD\r\n`, 200, 'text/vcard; charset=utf-8');
  }
  if (url.hostname === 'vcard.example.com' && url.pathname === '/contact' && failVcardFallbackOnce) {
    failVcardFallbackOnce = false;
    throw new Error('synthetic worker restart after vCard persistence');
  }
  if (url.hostname === 'vcard.example.com') return response('missing', 404, 'text/plain');
  if (['telephone.example.com', 'operator-phone.example.com'].includes(url.hostname) && url.pathname === '/') {
    return response('<html><body><a href="tel:12345">Short extension</a><a href="tel:+1-abc-555-0132">Malformed number</a><a href="tel:+1-212-555-0132">Call our office</a></body></html>');
  }
  if (['telephone.example.com', 'operator-phone.example.com'].includes(url.hostname)) return response('missing', 404, 'text/plain');
  if (url.hostname === 'social.example.com' && url.pathname === '/') {
    return response('<html><body><a href="https://m.facebook.com/social-fixture/?utm_source=website#about">Follow our company</a><a href="https://www.facebook.com/groups/123">Community group</a></body></html>');
  }
  if (url.hostname === 'social.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'microdata.example.com' && url.pathname === '/') {
    return response(`<html><body>
      <div itemscope itemtype="https://schema.org/Organization">
        <span itemprop="name">Microdata Fixture Business</span>
        <meta itemprop="industry" content="Industrial packaging">
        <div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">
          <span itemprop="streetAddress">7 Example Lane</span><span itemprop="addressLocality">Pune</span>
          <span itemprop="addressRegion">Maharashtra</span><meta itemprop="addressCountry" content="India">
        </div>
        <meta itemprop="email" content="office@microdata.example.com">
        <div itemprop="contactPoint" itemscope itemtype="https://schema.org/ContactPoint">
          <meta itemprop="contactType" content="sales">
          <div itemprop="employee" itemscope itemtype="https://schema.org/Person">
            <span itemprop="name">Maya Iyer</span><span itemprop="jobTitle">Sales Director</span>
          </div>
          <meta itemprop="email" content="sales@microdata.example.com">
        </div>
        <div itemprop="contactPoint" itemscope itemtype="https://schema.org/ContactPoint">
          <meta itemprop="contactType" content="support"><meta itemprop="email" content="support@microdata.example.com">
        </div>
      </div>
      <div itemscope itemtype="https://schema.org/Organization">
        <span itemprop="name">Unrelated Subsidiary</span><meta itemprop="email" content="owner@subsidiary.example.net">
      </div>
    </body></html>`);
  }
  if (url.hostname === 'hcard.example.com' && url.pathname === '/') {
    return response(`<html><body>
      <div class="h-card"><span class="p-name">H-Card Fixture Business</span>
        <a class="u-url" href="https://hcard.example.com/">Official site</a>
        <span class="p-tel">+1 212 555 0164</span>
        <span class="p-category">Industrial textiles</span>
        <div class="p-adr h-adr"><span class="p-street-address">16 Market Lane</span><span class="p-locality">Jaipur</span>
          <span class="p-region">Rajasthan</span><span class="p-postal-code">302001</span><span class="p-country-name">India</span></div>
        <span class="p-tel">extension 12</span>
        <span class="u-email">office@hcard.example.com</span>
        <div class="private"><a class="u-email" href="mailto:owner.private@gmail.com">private</a></div>
        <a class="u-email" href="mailto:wrong@hcard.example.com" data-private="true">private attribute</a>
      </div>
      <div class="h-card"><span class="p-name">Riya Kapoor</span><span class="p-org">H-Card Fixture Business</span>
        <span class="p-job-title">Export Partnerships Lead</span><span class="p-tel">+44 20 7946 0134</span>
        <span class="p-category">Person category must not replace company data</span>
        <div class="p-adr h-adr"><span class="p-street-address">99 Person Row</span><span class="p-locality">Delhi</span></div>
        <span class="u-email">riya@hcard.example.com</span>
        <div class="h-card"><span class="p-name">Unrelated Nested Person</span>
          <span class="u-email">nested@hcard.example.com</span></div>
      </div>
      <div class="h-card"><span class="p-name">Other Business</span><a class="u-url" href="https://hcard.example.com/">Website</a>
        <span class="u-email">other@hcard.example.com</span></div>
    </body></html>`);
  }
  if (url.hostname === 'person-jsonld.example.com' && url.pathname === '/') {
    return response(`<html><body>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@graph': [
        { '@type': 'Organization', name: 'Person JSON-LD Fixture', url: 'https://person-jsonld.example.com', employee: [
          { '@id': '#employee-1' }, { '@id': '#missing-person' }, { '@id': '#ambiguous-person' },
        ], founder: { '@type': 'Person', name: 'Dev Shah', jobTitle: 'Founder', email: 'dev@person-jsonld.example.com' },
        contactPoint: [{ '@id': '#sales-contact', '@type': 'ContactPoint' }, { '@id': '#missing-contact', '@type': 'ContactPoint' },
          { '@id': '#ambiguous-contact', '@type': 'ContactPoint' }, { '@id': '#wrong-type', '@type': 'ContactPoint' }] },
        { '@type': 'Organization', name: 'Unrelated Company', url: 'https://unrelated.invalid', member: {
          '@type': 'Person', name: 'Unrelated Member', jobTitle: 'Buyer', email: 'unrelated@person-jsonld.example.com',
        }, contactPoint: { '@id': '#unrelated-support', '@type': 'ContactPoint' } },
        { '@type': 'Organization', name: 'Person JSON-LD Fixture', url: 'https://wrong-host.invalid', member: {
          '@type': 'Person', name: 'Misattached Member', email: 'misattached@person-jsonld.example.com',
        } },
        ],
      })}</script>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@graph': [
        { '@id': '#employee-1', '@type': 'Person', name: 'Asha Menon', jobTitle: 'Commercial Director', email: 'asha@person-jsonld.example.com' },
        { '@id': '#ambiguous-person', '@type': 'Person', name: 'First Duplicate', email: 'first@person-jsonld.example.com' },
        { '@id': '#ambiguous-person', '@type': 'Person', name: 'Second Duplicate', email: 'second@person-jsonld.example.com' },
        { '@id': '#sales-contact', '@type': 'ContactPoint', contactType: 'sales', name: 'Rani Patel',
          jobTitle: 'Regional Sales Manager', email: 'sales@person-jsonld.example.com' },
        { '@id': '#unrelated-support', '@type': 'ContactPoint', contactType: 'support', name: 'Private Support',
          email: 'support@person-jsonld.example.com' },
        { '@id': '#ambiguous-contact', '@type': 'ContactPoint', email: 'first-contact@person-jsonld.example.com' },
        { '@id': '#ambiguous-contact', '@type': 'ContactPoint', email: 'second-contact@person-jsonld.example.com' },
        { '@id': '#wrong-type', '@type': 'Person', name: 'Not A Contact Point', email: 'wrong-type@person-jsonld.example.com' },
        ],
      })}</script>
    </body></html>`);
  }
  if (url.hostname === 'rdfa.example.com' && url.pathname === '/') {
    return response(`<html><body>
      <div typeof="schema:Organization">
        <span property="schema:name">RDFa Fixture Business</span>
        <a property="schema:url" href="https://rdfa.example.com/">Official website</a>
        <meta property="schema:email" content="office@rdfa.example.com">
        <meta property="schema:telephone" content="extension 12"><meta property="schema:telephone" content="+44 20 7946 0132">
        <meta property="schema:industry" content="Industrial automation">
        <div property="schema:address" typeof="schema:PostalAddress">
          <span property="schema:streetAddress">8 Market Road</span><span property="schema:addressLocality">Pune</span>
          <span property="schema:addressRegion">Maharashtra</span><meta property="schema:postalCode" content="411001">
          <meta property="schema:addressCountry" content="India">
        </div>
        <section property="schema:contactPoint" typeof="schema:ContactPoint">
          <meta property="schema:contactType" content="sales">
          <span property="schema:name">Mina Shah</span><span property="schema:jobTitle">Regional Sales Lead</span>
          <span property="schema:email">sales@rdfa.example.com</span>
          <div property="schema:employee" typeof="schema:Person">
            <span property="schema:name">Nested Person</span><span property="schema:email">nested@rdfa.example.com</span>
            <span property="schema:telephone">+44 20 7946 0999</span>
            <meta property="schema:industry" content="Person industry must not replace company data">
            <div property="schema:address" typeof="schema:PostalAddress"><span property="schema:streetAddress">99 Person Row</span>
              <span property="schema:addressLocality">Delhi</span></div>
          </div>
        </section>
        <div typeof="schema:Organization"><span property="schema:name">Different Subsidiary</span>
          <meta property="schema:email" content="subsidiary@rdfa.example.net"></div>
      </div>
      <div typeof="schema:Organization"><span property="schema:name">Other RDFa Business</span>
        <meta property="schema:email" content="other@rdfa.example.com"></div>
    </body></html>`);
  }
  if (url.hostname === 'meta-email.example.com' && url.pathname === '/') {
    return response(`<html><head>
      <meta name="description" content="decoy@meta-email.example.com">
      <meta name="author" content="author@meta-email.example.com">
      <meta name="contact-email" content="contact@meta-email.example.com">
      <meta name="contact_email" content="contact@meta-email.example.com">
      <meta name="BUSINESS_EMAIL" content="office@meta-email.example.com">
      <meta property="og:email" content="property-decoy@meta-email.example.com">
    </head><body><div data-email="attribute-decoy@meta-email.example.com"></div>
      <script>const privateAddress = 'script-decoy@meta-email.example.com';</script>
    </body></html>`);
  }
  if (url.hostname === 'meta-email.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'mailto-endpoints.example.com' && url.pathname === '/') {
    return response(`<html><head><link rel="author" href="MAILTO:link@mailto-endpoints.example.com?subject=Profile"></head><body>
      <map name="contact"><area href="mailto:area@mailto-endpoints.example.com,area2@mailto-endpoints.example.com?subject=Map" alt="Contact area"></map>
      <form action="mailto:form@mailto-endpoints.example.com?subject=Office"><input name="email"></form>
      <button formaction="mailto:button@mailto-endpoints.example.com?subject=Sales">Contact sales</button>
      <form action="mailto:form@mailto-endpoints.example.com?subject=Duplicate"></form>
      <form action="mailto:invalid-value"></form>
      <div class="private"><form action="mailto:private@mailto-endpoints.example.com"></form></div>
    </body></html>`);
  }
  if (url.hostname === 'mailto-endpoints.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'accessible-email.example.com' && url.pathname === '/') {
    return response(`<html><body>
      <a aria-label="Contact our public team at team@accessible-email.example.com"></a>
      <area title="Contact sales area@accessible-email.example.com">
      <button aria-label="Customer help help@accessible-email.example.com"></button>
      <input type="email" title="Billing finance@accessible-email.example.com">
      <img src="/brand.svg" alt="Export enquiries exports@accessible-email.example.com">
      <img src="/mark.svg" title="Executive contact exec@accessible-email.example.com">
      <img src="https://offsite.example.test/brand.svg" alt="Partner partner@outside.example.test">
      <div class="private"><button aria-label="Private private@accessible-email.example.com"></button></div>
      <div data-private="true"><input aria-label="Hidden private2@accessible-email.example.com"></div>
      <input type="hidden" title="Hidden field hidden@accessible-email.example.com">
      <div title="This is not an email address"></div>
    </body></html>`);
  }
  if (url.hostname === 'accessible-email.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'contact-attribute.example.com' && url.pathname === '/') {
    return response(`<html><body>
      <div data-contact-email="partnerships@contact-attribute.example.com"></div>
      <button data-business-email="sales@contact-attribute.example.com">Contact sales</button>
      <a data-contact-email="partnerships@contact-attribute.example.com">Duplicate</a>
      <div data-email="generic-decoy@contact-attribute.example.com"></div>
      <div data-contact-email="hidden@contact-attribute.example.com" hidden></div>
      <div aria-hidden="true"><span data-business-email="aria-hidden@contact-attribute.example.com"></span></div>
      <div class="confidential"><span data-contact-email="private@contact-attribute.example.com"></span></div>
      <input type="hidden" data-business-email="input-hidden@contact-attribute.example.com">
      <span data-contact-email="not an address"></span>
    </body></html>`);
  }
  if (url.hostname === 'contact-attribute.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'microdata.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'hcard.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'person-jsonld.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'rdfa.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'form-only.example.com' || url.hostname === 'hidden-form.example.com') return response('missing', 404, 'text/plain');
  if (url.hostname === 'northstar.example.com' && refreshMode !== 'original') {
    if (url.pathname === '/contact' && refreshMode === 'interrupted-contact') throw new Error('synthetic connection interruption');
    if (url.pathname === '/contact' && refreshMode === 'blocked-contact') return response('restricted', 403, 'text/plain');
    if (refreshMode === 'expanded' && url.pathname === '/') {
      return response('<html><body><a href="mailto:hello@northstar.example.com">Email us</a></body></html>');
    }
    if (refreshMode === 'expanded' && url.pathname === '/contact') {
      return response('<html><body><a href="mailto:press@northstar.example.com">Press</a><a href="mailto:sales@northstar.example.com">Sales</a></body></html>');
    }
    if (url.pathname === '/') return response('<html><body>Welcome to North Star Workshop.</body></html>');
    if (url.pathname === '/contact') return response('<html><body>Contact our team through the public form.</body></html>');
    if (url.pathname === '/about') return response('<html><body>About the workshop.</body></html>');
  }
  if (url.hostname === 'unvisited-refresh.example.com') {
    if (url.pathname === '/' && unvisitedRefreshMode === 'original') {
      return response('<html><body><a href="mailto:team@unvisited-refresh.example.com">Email</a><a href="/contact">Contact</a><a href="/about">About</a></body></html>');
    }
    if (url.pathname === '/' && unvisitedRefreshMode === 'conflict') return response('<html><body>Reach our team through the contact page.</body></html>');
    if (url.pathname === '/about') return response('<html><body><a href="mailto:team@unvisited-refresh.example.com">Team email</a></body></html>');
    if (url.pathname === '/contact' && unvisitedRefreshMode === 'interrupted') throw new Error('synthetic interrupted source');
    if (url.pathname === '/contact') return response('<html><body>Contact page.</body></html>');
    if (url.pathname === '/') return response('<html><body><a href="mailto:team@unvisited-refresh.example.com">Email</a></body></html>');
  }
  if (url.pathname === '/') return response('<html><body><a href="mailto:hello@northstar.example.com?subject=Hi">Email us</a><script>fake@northstar.example.com</script></body></html>');
  if (url.pathname === '/contact') return response('<html><body>For press contact press@northstar.example.com</body></html>');
  if (url.pathname === '/about') return response('<html><body>Our team</body></html>');
  return response('missing', 404, 'text/plain');
}

const discovery = createWebsiteEmailDiscovery({ db, fetchImpl: fixtureFetch, minimumRequestIntervalMs: 0, wait: async () => {} });
setWebsiteEmailDiscoveryTestManager(discovery);
if (!server.listening) await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.once('listening', resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDb();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function request(route, method = 'GET') {
  const responseResult = await fetch(`${base}${route}`, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
  });
  return { status: responseResult.status, body: await responseResult.json() };
}

test('contact detail exposes one-time action; API stores source evidence as unknown and never queues a send', async () => {
  const initial = await request(`/api/leads/${leadId}`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.email_discovery, null);
  assert.match(renderLeadDetail({ ...initial.body, tags: [], events: [], customFields: [] }), /Find public emails once/);
  assert.match(renderLeadDetail({ ...initial.body, tags: [], events: [], customFields: [] }), /checks robots\.txt/);

  const result = await request(`/api/leads/${leadId}/website-email-scan`, 'POST');
  assert.equal(result.status, 201);
  assert.equal(result.body.scan.status, 'completed');
  assert.equal(result.body.scan.page_count, 3);
  assert.equal(result.body.addedCount, 2);
  assert.deepEqual(result.body.emails.map(item => item.email).sort(), [
    'hello@northstar.example.com', 'press@northstar.example.com',
  ]);
  assert.ok(result.body.emails.every(item => item.verification_status === 'unknown'));
  assert.match(result.body.message, /remains unverified/);

  const final = await request(`/api/leads/${leadId}`);
  assert.equal(final.body.email_discovery.status, 'completed');
  assert.deepEqual(final.body.emails.map(item => item.verification_status), ['unknown', 'unknown']);
  assert.ok(final.body.emails.every(item => item.source === 'website_scan' && item.is_primary === 0 && item.verified_at === null));
  assert.deepEqual(final.body.emails.map(item => item.source_evidence[0].source_url).sort(), [
    'https://northstar.example.com/', 'https://northstar.example.com/contact',
  ]);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id=?').get(leadId).status, 'discovered');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(leadId).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM events WHERE lead_id=? AND event_type='website_email_scan_completed'").get(leadId).count, 1);

  const callsAfterScan = fetchCalls.length;
  const repeated = await request(`/api/leads/${leadId}/website-email-scan`, 'POST');
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.code, 'already_scanned');
  assert.equal(fetchCalls.length, callsAfterScan, 'a second click must not issue any website request');
  const html = renderLeadDetail({ ...final.body, tags: [], events: [], customFields: [] });
  assert.doesNotMatch(html, /data-website-email-scan/);
  assert.match(html, /Scan complete/);
  assert.match(html, /northstar\.example\.com\/contact/);

  for (const call of fetchCalls) {
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.headers['User-Agent'], WEBSITE_EMAIL_USER_AGENT);
    assert.ok(call.options.maxBytes <= 512 * 1024);
  }
  assert.equal(new Set(fetchCalls.map(call => new URL(call.url).origin)).size, 1);
  assert.ok(fetchCalls.some(call => new URL(call.url).pathname === '/robots.txt'));
});

test('explicit refresh preserves evidence history and only marks absence after a successful same-source fetch', async () => {
  refreshMode = 'removed';
  const refresh = await request(`/api/leads/${leadId}/website-email-scan/refresh`, 'POST');
  assert.equal(refresh.status, 200);
  assert.equal(refresh.body.scan.status, 'completed');
  assert.equal(refresh.body.scan.latest_refresh.generation, 1);
  assert.equal(refresh.body.scan.latest_refresh.status, 'completed');
  assert.ok(refresh.body.scan.latest_refresh.page_count >= 2);

  const rows = db.prepare(`SELECT le.email,ev.source_url,o.state,o.prior_content_hash,o.content_hash
    FROM lead_website_email_refresh_observations o
    JOIN lead_emails le ON le.id=o.lead_email_id
    JOIN lead_email_source_evidence ev ON ev.lead_email_id=le.id AND ev.source_url=o.source_url
    WHERE o.refresh_id=? ORDER BY le.email`).all(refresh.body.scan.latest_refresh.id);
  assert.deepEqual(rows.map(row => [row.email, row.state]).sort(), [
    ['hello@northstar.example.com', 'not_present'],
    ['press@northstar.example.com', 'not_present'],
  ]);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.prior_content_hash)));
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.content_hash)));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_website_email_refresh_observations WHERE refresh_id=?').get(refresh.body.scan.latest_refresh.id).count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(leadId).count, 2,
    'a source disappearance keeps the contact email row and its original evidence');
  assert.ok(db.prepare('SELECT verification_status FROM lead_emails WHERE lead_id=?').all(leadId)
    .every(row => row.verification_status === 'unknown'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(leadId).count, 0);

  const detail = await request(`/api/leads/${leadId}`);
  assert.equal(detail.body.email_discovery.latest_refresh.status, 'completed');
  assert.equal(refresh.body.currentRefreshFoundCount, 0);
  assert.match(refresh.body.message, /0 address\(es\) seen/);
  assert.ok(detail.body.emails.flatMap(item => item.source_evidence).every(item => item.refresh_state === 'not_present'));
  const html = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(html, /Refresh \d+ saved pages/);
  assert.match(html, /Not seen on last successful refresh/);
  assert.match(html, /Historical evidence is retained/);

  refreshMode = 'blocked-contact';
  const partial = await request(`/api/leads/${leadId}/website-email-scan/refresh`, 'POST');
  assert.equal(partial.status, 200);
  assert.equal(partial.body.scan.status, 'blocked');
  assert.equal(partial.body.scan.latest_refresh.generation, 2);
  const press = db.prepare(`SELECT le.id FROM lead_emails le WHERE le.lead_id=? AND le.email=?`)
    .get(leadId, 'press@northstar.example.com');
  const pressState = db.prepare(`SELECT o.state FROM lead_website_email_refresh_observations o
    WHERE o.refresh_id=? AND o.lead_email_id=?`).get(partial.body.scan.latest_refresh.id, press.id);
  assert.equal(pressState, undefined, 'a blocked page creates no presence or absence observation');
  const refreshedDetail = await request(`/api/leads/${leadId}`);
  const pressEvidence = refreshedDetail.body.emails.find(item => item.email === 'press@northstar.example.com').source_evidence[0];
  assert.equal(pressEvidence.refresh_state, 'blocked', 'latest blocked attempt overrides an older absence state in the UI');
  assert.match(renderLeadDetail({ ...refreshedDetail.body, tags: [], events: [], customFields: [] }), /access or robots restriction/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(leadId).count, 0);

  refreshMode = 'expanded';
  const expanded = await request(`/api/leads/${leadId}/website-email-scan/refresh`, 'POST');
  assert.equal(expanded.status, 200);
  assert.equal(expanded.body.scan.latest_refresh.generation, 3);
  assert.equal(expanded.body.currentRefreshFoundCount, 3);
  const states = db.prepare(`SELECT le.email,o.state,o.prior_content_hash FROM lead_website_email_refresh_observations o
    JOIN lead_emails le ON le.id=o.lead_email_id WHERE o.refresh_id=? ORDER BY le.email`)
    .all(expanded.body.scan.latest_refresh.id);
  assert.deepEqual(states.map(row => [row.email, row.state]), [
    ['hello@northstar.example.com', 'present'],
    ['press@northstar.example.com', 'present'],
    ['sales@northstar.example.com', 'present'],
  ]);
  assert.equal(states.find(row => row.email === 'sales@northstar.example.com').prior_content_hash, null,
    'newly observed email has no fabricated prior source hash');

  refreshMode = 'interrupted-contact';
  const interrupted = await request(`/api/leads/${leadId}/website-email-scan/refresh`, 'POST');
  assert.equal(interrupted.status, 200);
  assert.equal(interrupted.body.scan.status, 'failed');
  assert.equal(interrupted.body.scan.latest_refresh.generation, 4);
  const interruptedContactPage = db.prepare(`SELECT outcome FROM lead_website_email_refresh_pages
    WHERE refresh_id=? AND source_url=?`).get(interrupted.body.scan.latest_refresh.id, 'https://northstar.example.com/contact');
  assert.equal(interruptedContactPage.outcome, 'unavailable');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM lead_website_email_refresh_observations
    WHERE refresh_id=? AND source_url='https://northstar.example.com/contact'`).get(interrupted.body.scan.latest_refresh.id).count, 0,
  'a request interruption does not infer absence for that page');

  const interruptedGeneration = Number(db.prepare(`INSERT INTO lead_website_email_refreshes(lead_id,generation,website_url,status)
    VALUES(?,5,'https://northstar.example.com/','running')`).run(leadId).lastInsertRowid);
  db.prepare(`UPDATE lead_website_email_scans SET status='running',pending_paths_json='["/contact"]' WHERE lead_id=?`).run(leadId);
  assert.equal(discovery.recoverInterruptedScans(), 1);
  assert.equal(db.prepare('SELECT status FROM lead_website_email_refreshes WHERE id=?').get(interruptedGeneration).status, 'interrupted');
  assert.equal(discovery.getLeadScan(leadId).status, 'interrupted');
  refreshMode = 'expanded';
  const recovered = await request(`/api/leads/${leadId}/website-email-scan/refresh`, 'POST');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.scan.latest_refresh.generation, 6);
  assert.equal(recovered.body.scan.status, 'completed', 'recovery is explicit and checks the saved pending source again');
  refreshMode = 'original';
});

test('a source page not reached by an interrupted generation is shown as not rechecked', async () => {
  const initial = await request(`/api/leads/${unvisitedRefreshLeadId}/website-email-scan`, 'POST');
  assert.equal(initial.status, 201);
  assert.equal(initial.body.scan.status, 'completed');
  assert.ok(initial.body.emails[0].source_evidence.some(item => item.source_url.endsWith('/about')));

  unvisitedRefreshMode = 'interrupted';
  const failed = await request(`/api/leads/${unvisitedRefreshLeadId}/website-email-scan/refresh`, 'POST');
  assert.equal(failed.status, 200);
  assert.equal(failed.body.scan.status, 'failed');
  const detail = await request(`/api/leads/${unvisitedRefreshLeadId}`);
  const aboutEvidence = detail.body.emails[0].source_evidence.find(item => item.source_url.endsWith('/about'));
  assert.equal(aboutEvidence.refresh_state, 'not_rechecked');
  assert.match(renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] }), /Not rechecked during the latest refresh/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(unvisitedRefreshLeadId).count, 0);

  unvisitedRefreshMode = 'conflict';
  const conflictRefresh = await request(`/api/leads/${unvisitedRefreshLeadId}/website-email-scan/refresh`, 'POST');
  assert.equal(conflictRefresh.status, 200);
  assert.equal(conflictRefresh.body.scan.status, 'completed');
  const conflictDetail = await request(`/api/leads/${unvisitedRefreshLeadId}`);
  const teamEmail = conflictDetail.body.emails.find(item => item.email === 'team@unvisited-refresh.example.com');
  assert.deepEqual(teamEmail.source_conflict, {
    generation: conflictRefresh.body.scan.latest_refresh.generation,
    present_sources: ['https://unvisited-refresh.example.com/about'],
    absent_sources: ['https://unvisited-refresh.example.com/'],
  });
  assert.match(renderLeadDetail({ ...conflictDetail.body, tags: [], events: [], customFields: [] }), /Source disagreement/);
  const hostile = structuredClone(conflictDetail.body);
  hostile.emails[0].source_evidence[0].refresh_history[0].prior_excerpt = '<img src=x onerror=alert(1)>';
  const safeHtml = renderLeadDetail({ ...hostile, tags: [], events: [], customFields: [] });
  assert.doesNotMatch(safeHtml, /<img src=x/);
  assert.match(safeHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  unvisitedRefreshMode = 'original';
});

test('robots disallow and robots failure stop before fetching site pages; attempts cannot be repeated', async () => {
  const before = fetchCalls.length;
  const denied = await request(`/api/leads/${blockedLeadId}/website-email-scan`, 'POST');
  assert.equal(denied.status, 201);
  assert.equal(denied.body.scan.status, 'blocked');
  assert.equal(denied.body.scan.error_code, 'robots_disallowed');
  assert.equal(fetchCalls.slice(before).length, 1);
  assert.equal(new URL(fetchCalls.at(-1).url).pathname, '/robots.txt');
  assert.equal((await request(`/api/leads/${blockedLeadId}/website-email-scan`, 'POST')).status, 409);

  const failureBefore = fetchCalls.length;
  const unavailable = await request(`/api/leads/${failedLeadId}/website-email-scan`, 'POST');
  assert.equal(unavailable.status, 201);
  assert.equal(unavailable.body.scan.status, 'failed');
  assert.equal(unavailable.body.scan.error_code, 'robots_http_503');
  assert.equal(fetchCalls.slice(failureBefore).length, 1);
});

test('concurrent requests reserve one scan; an interrupted reservation survives restart without retry', async () => {
  const concurrentLeadId = Number(db.prepare("INSERT INTO leads(batch_id,business_name,website_url) VALUES (?,?,?)")
    .run(batchId, 'Concurrent Shop', 'https://concurrent.example.com').lastInsertRowid);
  mode = 'hold';
  const firstRequest = request(`/api/leads/${concurrentLeadId}/website-email-scan`, 'POST').then(value => ({ value }), error => ({ error }));
  let timeoutId;
  const timeout = new Promise(resolve => { timeoutId = setTimeout(() => resolve('timed-out'), 3000); });
  const firstStage = await Promise.race([
    robotsStarted.then(() => 'robots-started'),
    firstRequest.then(result => ({ requestFinished: result })),
    timeout,
  ]);
  clearTimeout(timeoutId);
  assert.equal(firstStage, 'robots-started', `initial scan did not reach robots: ${JSON.stringify(firstStage)}`);
  const requestsWhileRunning = fetchCalls.length;
  const second = await request(`/api/leads/${concurrentLeadId}/website-email-scan`, 'POST');
  assert.equal(second.status, 409);
  assert.equal(second.body.scan.status, 'running');
  assert.equal(fetchCalls.length, requestsWhileRunning);
  heldRobotsResolve(response('User-agent: *\nAllow: /', 200, 'text/plain'));
  const firstResult = await firstRequest;
  assert.ok(firstResult.value, firstResult.error?.message || 'first HTTP request failed');
  const first = firstResult.value;
  assert.equal(first.status, 201);
  mode = 'normal';

  const restarted = createWebsiteEmailDiscovery({ db, fetchImpl: fixtureFetch, minimumRequestIntervalMs: 0, wait: async () => {} });
  assert.equal(discovery.getLeadScan(interruptedLeadId).status, 'interrupted', 'application startup recovery closes a stale attempt');
  assert.equal(restarted.recoverInterruptedScans(), 0, 'a second recovery pass is idempotent');
  assert.equal(restarted.getLeadScan(interruptedLeadId).status, 'interrupted');
  const beforeRetry = fetchCalls.length;
  await assert.rejects(restarted.scanLead(interruptedLeadId), error => error.code === 'already_scanned');
  assert.equal(fetchCalls.length, beforeRetry);
});

test('robots matching uses the most specific group and allow wins equal-length ties', () => {
  const policy = parseRobotsPolicy([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/contact',
    'User-agent: OddEcosysLeadResearch',
    'Disallow: /',
    'Allow: /about',
  ].join('\n'));
  assert.equal(policy.canFetch('/'), false);
  assert.equal(policy.canFetch('/about'), true);
  assert.equal(policy.canFetch('/private/contact'), false, 'specific bot group replaces the wildcard group');
  const tie = parseRobotsPolicy('User-agent: *\nDisallow: /x\nAllow: /x');
  assert.equal(tie.canFetch('/x'), true);
});

test('SSRF guard blocks private website targets and robots crawl-delay is applied host-wide', async () => {
  const privateLeadId = Number(db.prepare('INSERT INTO leads(batch_id,business_name,website_url) VALUES (?,?,?)')
    .run(batchId, 'Private Address Fixture', 'http://127.0.0.1').lastInsertRowid);
  const guarded = createWebsiteEmailDiscovery({ db, minimumRequestIntervalMs: 0 });
  const blocked = await guarded.scanLead(privateLeadId);
  assert.equal(blocked.scan.status, 'failed');
  assert.equal(blocked.scan.error_code, 'unsafe_website_url');

  const pacedLeadId = Number(db.prepare('INSERT INTO leads(batch_id,business_name,website_url) VALUES (?,?,?)')
    .run(batchId, 'Paced Website Fixture', 'https://pace.example.net').lastInsertRowid);
  let virtualNow = 1000;
  const waits = [];
  const requests = [];
  const paced = createWebsiteEmailDiscovery({
    db,
    now: () => virtualNow,
    wait: async milliseconds => { waits.push(milliseconds); virtualNow += milliseconds; },
    fetchImpl: async input => {
      const url = new URL(input);
      requests.push(url.href);
      if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /\nCrawl-delay: 2', 200, 'text/plain');
      return response('<html><body>hello@pace.example.net</body></html>');
    },
  });
  const result = await paced.scanLead(pacedLeadId);
  assert.equal(result.scan.status, 'completed');
  assert.equal(requests.length, 6, 'one robots check and at most five same-origin HTML pages');
  assert.deepEqual(waits, [2000, 2000, 2000, 2000, 2000], 'robots crawl-delay spaces every request on that hostname');
});

test('homepage contact links are prioritized and off-site, irrelevant, and sensitive paths are skipped', async () => {
  const id = Number(db.prepare('INSERT INTO leads(batch_id,business_name,website_url) VALUES (?,?,?)')
    .run(batchId, 'Linked Pages Fixture', 'https://links.example.test').lastInsertRowid);
  const paths = [];
  const hosts = [];
  const linked = createWebsiteEmailDiscovery({
    db, minimumRequestIntervalMs: 0, wait: async () => {},
    fetchImpl: async input => {
      const url = new URL(input); paths.push(url.pathname); hosts.push(url.hostname);
      if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /', 200, 'text/plain');
      if (url.pathname === '/') return response('<map name="sales"><area href="/company/registry" alt="Contact our sales team" title="Contact our sales team"></map><a href="/company/contact-us">Contact</a><a href="/about/team">Our team</a><a href="/blog/latest">Blog</a><a href="/privacy/contact">Privacy contact</a><a href="https://outside.example.test/contact">Partner</a><area href="https://outside.example.test/contact-team" alt="Contact our sales team">');
      if (url.pathname === '/company/registry') return response('<main>Image map office: registry@links.example.test</main>');
      if (url.pathname === '/company/contact-us') return response('<main>Sales: sales@links.example.test</main>');
      if (url.pathname === '/about/team') return response('<main>Team: hello@links.example.test</main>');
      return response('missing', 404, 'text/plain');
    },
  });
  const result = await linked.scanLead(id);
  assert.equal(result.scan.status, 'completed');
  assert.deepEqual(paths.slice(0, 5), ['/robots.txt', '/', '/company/registry', '/company/contact-us', '/about/team']);
  assert.ok(!paths.includes('/blog/latest'));
  assert.ok(!paths.includes('/privacy/contact'));
  assert.equal(hosts.includes('outside.example.test'), false, 'off-site image-map links are never requested');
  assert.ok(paths.indexOf('/company/contact-us') < paths.indexOf('/contact'), 'the dynamic contact path outranks fallback guesses');
  assert.ok(result.emails.some(email => email.email === 'registry@links.example.test'));
  assert.ok(result.emails.some(email => email.email === 'sales@links.example.test'));
  assert.ok(result.emails.some(email => email.email === 'hello@links.example.test'));
  assert.ok(result.emails.every(email => email.source_evidence.every(item => new URL(item.source_url).origin === 'https://links.example.test')));
});

test('robots-declared same-origin sitemap adds relevant pages and ignores unrelated or external URLs', async () => {
  const id = Number(db.prepare('INSERT INTO leads(batch_id,business_name,website_url) VALUES (?,?,?)')
    .run(batchId, 'Sitemap Fixture', 'https://sitemap.example.test').lastInsertRowid);
  const paths = [];
  const fromMap = createWebsiteEmailDiscovery({
    db, minimumRequestIntervalMs: 0, wait: async () => {},
    fetchImpl: async input => {
      const url = new URL(input); paths.push(url.pathname);
      if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /\nSitemap: https://sitemap.example.test/public.xml', 200, 'text/plain');
      if (url.pathname === '/public.xml') return response('<urlset><url><loc>https://sitemap.example.test/en/contact</loc></url><url><loc>https://sitemap.example.test/blog/post</loc></url><url><loc>https://elsewhere.example/contact</loc></url></urlset>', 200, 'application/xml');
      if (url.pathname === '/en/contact') return response('<main>Contact: export@sitemap.example.test</main>');
      if (url.pathname === '/') return response('<html><body>Company home</body></html>');
      return response('missing', 404, 'text/plain');
    },
  });
  const result = await fromMap.scanLead(id);
  assert.equal(result.scan.status, 'completed');
  assert.deepEqual(paths.slice(0, 4), ['/robots.txt', '/', '/public.xml', '/en/contact']);
  assert.ok(!paths.includes('/blog/post'));
  assert.ok(paths.indexOf('/en/contact') < paths.indexOf('/contact'), 'sitemap evidence is searched before guessed contact routes');
  assert.ok(result.emails.some(email => email.email === 'export@sitemap.example.test'));
});

test('interrupted scan resumes from its persisted focused-link queue without refetching the homepage', async () => {
  const id = Number(db.prepare('INSERT INTO leads(batch_id,business_name,website_url) VALUES (?,?,?)')
    .run(batchId, 'Queue Resume Fixture', 'https://resume.example.test').lastInsertRowid);
  db.prepare(`INSERT INTO lead_website_email_scans(lead_id,status,attempt_count,visited_paths_json,pending_paths_json)
    VALUES(?,'interrupted',1,'["/"]','["/contact/sales"]')`).run(id);
  const paths = [];
  const resume = createWebsiteEmailDiscovery({
    db, minimumRequestIntervalMs: 0, wait: async () => {},
    fetchImpl: async input => {
      const url = new URL(input); paths.push(url.pathname);
      if (url.pathname === '/robots.txt') return response('User-agent: *\nAllow: /', 200, 'text/plain');
      if (url.pathname === '/contact/sales') return response('<main>Sales: resume@resume.example.test</main>');
      throw new Error(`Unexpected refetch: ${url.pathname}`);
    },
  });
  const result = await resume.scanLead(id, { resumeInterrupted: true });
  assert.equal(result.scan.status, 'completed');
  assert.deepEqual(paths, ['/robots.txt', '/contact/sales']);
  assert.deepEqual(JSON.parse(result.scan.visited_paths_json), ['/', '/contact/sales']);
  assert.deepEqual(JSON.parse(result.scan.pending_paths_json), []);
  assert.equal(result.emails[0].email, 'resume@resume.example.test');
});

test('JSON-LD business email and profile fields persist with evidence without replacing operator data', async () => {
  const scanned = await request(`/api/leads/${structuredLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.equal(scanned.body.addedCount, 3);
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'info@structured.example.com', 'sales@structured.example.com', 'support@structured.example.com',
  ]);
  assert.ok(scanned.body.emails.every(item => item.verification_status === 'unknown'));
  assert.ok(scanned.body.emails.every(item => item.source_evidence[0].evidence_type === 'website_json_ld'));
  const sales = scanned.body.emails.find(item => item.email === 'sales@structured.example.com');
  assert.deepEqual(sales.source_evidence[0].contact_points, [{
    contact_type: 'sales', contact_name: 'Maya Singh', contact_title: 'Regional Sales Manager',
  }]);
  const support = scanned.body.emails.find(item => item.email === 'support@structured.example.com');
  assert.deepEqual(support.source_evidence[0].contact_points, [{
    contact_type: 'customer support', contact_name: null, contact_title: null,
  }]);
  assert.deepEqual(scanned.body.emails.find(item => item.email === 'info@structured.example.com').source_evidence[0].contact_points, []);

  const detail = await request(`/api/leads/${structuredLeadId}`);
  assert.equal(detail.body.business_name, 'Operator confirmed name');
  assert.equal(detail.body.category, 'Operator category');
  assert.equal(detail.body.address, 'Operator address');
  assert.equal(detail.body.city, 'Albany');
  assert.equal(detail.body.state, 'New York');
  assert.equal(detail.body.country, 'United States');
  assert.equal(detail.body.phone, '+1 212 555 0199');
  assert.equal(detail.body.facebook_url, 'https://www.facebook.com/operator-page');
  assert.equal(detail.body.consent_recorded_at, null);
  assert.equal(detail.body.profile_source_evidence.length, 1);
  assert.equal(detail.body.profile_source_evidence[0].evidence_type, 'website_json_ld_profile');
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /Structured Source Name/);
  const detailHtml = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(detailHtml, /Business profile source evidence/);
  assert.match(detailHtml, /website_json_ld_profile/);
  assert.match(detailHtml, /Contact type: sales/);
  assert.match(detailHtml, /Contact: Maya Singh/);
  assert.match(detailHtml, /Role: Regional Sales Manager/);
  assert.match(detailHtml, /Contact type: customer support/);
  assert.equal(detailHtml.includes('<script>'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_email_contact_point_evidence').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(structuredLeadId).count, 0);
});

test('explicitly obfuscated public addresses retain their original snippet and are never guessed from ordinary prose', async () => {
  const scanned = await request(`/api/leads/${obfuscatedLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.equal(scanned.body.scan.found_count, 1);
  assert.equal(scanned.body.emails.length, 1);
  assert.equal(scanned.body.emails[0].email, 'sales@obfuscated.example');
  assert.equal(scanned.body.emails[0].verification_status, 'unknown');
  assert.equal(scanned.body.emails[0].source_evidence[0].evidence_type, 'obfuscated_text');
  assert.match(scanned.body.emails[0].source_evidence[0].raw_excerpt, /sales \(at\) obfuscated \(dot\) example/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(obfuscatedLeadId).count, 0);
});

test('a site with a public contact form and no email persists source evidence without submitting it', async () => {
  const before = fetchCalls.length;
  const scanned = await request(`/api/leads/${formLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.equal(scanned.body.scan.found_count, 0);
  assert.equal(scanned.body.scan.error_code, 'contact_form_only');
  const detail = await request(`/api/leads/${formLeadId}`);
  const formEvidence = detail.body.profile_source_evidence.filter(item => item.evidence_type === 'website_contact_form');
  assert.equal(formEvidence.length, 1);
  assert.equal(formEvidence[0].source_url, 'https://form-only.example.com/');
  assert.match(formEvidence[0].content_hash, /^[a-f0-9]{64}$/);
  assert.equal(formEvidence[0].extractor_version, 'website-contact-form-v1');
  assert.equal(formEvidence[0].raw_excerpt, 'Public contact/enquiry form observed. No fields were submitted or values collected.');
  const detailHtml = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(detailHtml, /No fields were submitted or values collected/i);
  assert.match(detailHtml, /https:\/\/form-only\.example\.com\//);
  assert.ok(fetchCalls.slice(before).every(call => call.options.method !== 'POST'), 'form actions are never submitted');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_emails WHERE lead_id=?').get(formLeadId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(formLeadId).count, 0);
});

test('hidden, private, and hidden-input-only forms do not produce a public contact-form outcome', async () => {
  const scanned = await request(`/api/leads/${hiddenFormLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.equal(scanned.body.scan.error_code, 'email_not_found');
  const detail = await request(`/api/leads/${hiddenFormLeadId}`);
  assert.equal(detail.body.profile_source_evidence.some(item => item.evidence_type === 'website_contact_form'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(hiddenFormLeadId).count, 0);
});

test('only explicitly linked same-business vCards contribute public work addresses with source evidence', async () => {
  failVcardFallbackOnce = true;
  const scanned = await request(`/api/leads/${vcardLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'failed');
  assert.equal(scanned.body.scan.error_code, 'website_request_failed');
  assert.deepEqual(scanned.body.emails.map(item => item.email), ['nora@vcard.example.com']);
  const address = scanned.body.emails[0];
  assert.equal(address.verification_status, 'unknown');
  assert.deepEqual(address.source_evidence.map(({ source_url, evidence_type, extractor_version, content_hash, contact_points }) => ({
    source_url, evidence_type, extractor_version, content_hash: /^[a-f0-9]{64}$/.test(content_hash), contact_points,
  })), [{
    source_url: 'https://vcard.example.com/team.vcf', evidence_type: 'website_vcard', extractor_version: 'website-vcard-v1',
    content_hash: true, contact_points: [{ contact_type: null, contact_name: 'Nora Shah', contact_title: 'Business Development Lead' }],
  }]);
  const fetchedHosts = fetchCalls.map(call => new URL(call.url).hostname);
  assert.equal(fetchedHosts.includes('other.example.net'), false, 'off-site card links are never requested');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(vcardLeadId).count, 0);

  const vcardFetchCount = fetchCalls.filter(call => new URL(call.url).pathname === '/team.vcf').length;
  const restarted = createWebsiteEmailDiscovery({ db, fetchImpl: fixtureFetch, minimumRequestIntervalMs: 0, wait: async () => {} });
  const recovered = await restarted.scanLead(vcardLeadId, { retryFailed: true });
  assert.equal(recovered.scan.status, 'completed');
  assert.equal(recovered.addedCount, 0, 'restart uses the saved vCard evidence instead of inserting another address');
  assert.equal(fetchCalls.filter(call => new URL(call.url).pathname === '/team.vcf').length, vcardFetchCount,
    'the already visited vCard is not fetched again after restart');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lead_email_contact_point_evidence').get().count, 3,
    'only sales/support schema.org points and the single accepted vCard person remain, with no replay duplicate');
  setWebsiteEmailDiscoveryTestManager(restarted);

  const detail = await request(`/api/leads/${vcardLeadId}`);
  assert.equal(detail.body.emails[0].verification_status, 'unknown');
  assert.deepEqual(detail.body.emails[0].source_evidence[0].contact_points, address.source_evidence[0].contact_points);
  assert.match(renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] }), /Business Development Lead/);
});

test('explicit public tel links fill an empty business phone with evidence and preserve operator data', async () => {
  const scanned = await request(`/api/leads/${telLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.equal(scanned.body.scan.found_count, 0);
  const detail = await request(`/api/leads/${telLeadId}`);
  assert.equal(detail.body.phone, '+1-212-555-0132');
  assert.equal(detail.body.profile_source_evidence.length, 1);
  assert.equal(detail.body.profile_source_evidence[0].evidence_type, 'website_tel_profile');
  assert.equal(detail.body.profile_source_evidence[0].source_url, 'https://telephone.example.com/');
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /tel:\+1-212-555-0132/);
  const html = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(html, /\+1-212-555-0132/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(telLeadId).count, 0);

  const protectedScan = await request(`/api/leads/${operatorTelLeadId}/website-email-scan`, 'POST');
  assert.equal(protectedScan.status, 201);
  assert.equal((await request(`/api/leads/${operatorTelLeadId}`)).body.phone, 'Operator entered phone');
});

test('visible public Facebook business links persist with provenance without requesting social networks', async () => {
  const before = fetchCalls.length;
  const scanned = await request(`/api/leads/${socialLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  const detail = await request(`/api/leads/${socialLeadId}`);
  assert.equal(detail.body.facebook_url, 'https://www.facebook.com/social-fixture/');
  assert.equal(detail.body.profile_source_evidence.length, 1);
  assert.equal(detail.body.profile_source_evidence[0].evidence_type, 'website_facebook_profile');
  assert.equal(detail.body.profile_source_evidence[0].source_url, 'https://social.example.com/');
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /Facebook page link: https:\/\/www\.facebook\.com\/social-fixture\//);
  const html = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(html, /Facebook business page/);
  assert.match(html, /https:\/\/www\.facebook\.com\/social-fixture\//);
  assert.equal(fetchCalls.slice(before).some(call => /(^|\.)facebook\.com$/i.test(new URL(call.url).hostname)), false,
    'the linked social-network page is never fetched');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(socialLeadId).count, 0);
});

test('Organization and nested ContactPoint Microdata persist only for the matching business', async () => {
  const scanned = await request(`/api/leads/${microdataLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.equal(scanned.body.addedCount, 3);
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'office@microdata.example.com', 'sales@microdata.example.com', 'support@microdata.example.com',
  ]);
  const sales = scanned.body.emails.find(item => item.email === 'sales@microdata.example.com');
  assert.equal(sales.verification_status, 'unknown');
  assert.equal(sales.source_evidence[0].evidence_type, 'website_microdata');
  assert.deepEqual(sales.source_evidence[0].contact_points, [{
    contact_type: 'sales', contact_name: 'Maya Iyer', contact_title: 'Sales Director',
  }]);
  const support = scanned.body.emails.find(item => item.email === 'support@microdata.example.com');
  assert.deepEqual(support.source_evidence[0].contact_points, [{
    contact_type: 'support', contact_name: null, contact_title: null,
  }]);
  assert.equal(scanned.body.emails.some(item => item.email === 'owner@subsidiary.example.net'), false,
    'a nested, differently named Organization does not leak into the lead');
  const detail = await request(`/api/leads/${microdataLeadId}`);
  assert.equal(detail.body.business_name, 'Microdata Fixture Business');
  assert.equal(detail.body.category, 'Operator category');
  assert.equal(detail.body.city, 'Pune');
  assert.equal(detail.body.state, 'Maharashtra');
  assert.equal(detail.body.country, 'India');
  assert.match(renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] }), /Contact type: sales/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(microdataLeadId).count, 0);
});

test('h-card extraction keeps exact business and person-card email relationships scoped', async () => {
  const scanned = await request(`/api/leads/${hCardLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'nested@hcard.example.com', 'office@hcard.example.com', 'other@hcard.example.com', 'riya@hcard.example.com',
  ]);
  const office = scanned.body.emails.find(item => item.email === 'office@hcard.example.com');
  assert.equal(office.verification_status, 'unknown');
  assert.equal(office.source_evidence[0].evidence_type, 'website_hcard');
  assert.deepEqual(office.source_evidence[0].contact_points, []);
  const person = scanned.body.emails.find(item => item.email === 'riya@hcard.example.com');
  assert.equal(person.verification_status, 'unknown');
  assert.deepEqual(person.source_evidence[0].contact_points, [{
    contact_type: null, contact_name: 'Riya Kapoor', contact_title: 'Export Partnerships Lead',
  }]);
  const detail = await request(`/api/leads/${hCardLeadId}`);
  const html = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(html, /Riya Kapoor/);
  assert.match(html, /Export Partnerships Lead/);
  assert.equal(detail.body.phone, '+1 212 555 0164', 'person-card phone does not replace the company phone');
  assert.equal(detail.body.category, 'Industrial textiles');
  assert.equal(detail.body.city, 'Jaipur');
  assert.equal(detail.body.state, 'Rajasthan');
  assert.equal(detail.body.address, '16 Market Lane, Jaipur, Rajasthan, 302001, India');
  assert.match(html, /Industrial textiles/);
  assert.match(html, /16 Market Lane, Jaipur, Rajasthan, 302001, India/);
  assert.match(html, /Rajasthan/);
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /h-card business telephone/);
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /h-card business profile/);
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /Industrial textiles/);
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /16 Market Lane/);
  for (const excluded of ['owner.private@gmail.com', 'wrong@hcard.example.com']) {
    assert.equal(scanned.body.emails.some(item => item.email === excluded), false, `${excluded} must be excluded`);
  }
  for (const unassociated of ['nested@hcard.example.com', 'other@hcard.example.com']) {
    const candidate = scanned.body.emails.find(item => item.email === unassociated);
    assert.ok(candidate, 'visible public text may remain a generic candidate');
    assert.equal(candidate.source_evidence.some(item => item.evidence_type === 'website_hcard'), false,
      `${unassociated} must not inherit an h-card contact association`);
    assert.ok(candidate.source_evidence.every(item => item.contact_points.length === 0));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(hCardLeadId).count, 0);
});

test('Schema.org employee and founder emails require a matching parent business', async () => {
  const requestStart = fetchCalls.length;
  const scanned = await request(`/api/leads/${jsonLdPersonLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'asha@person-jsonld.example.com', 'dev@person-jsonld.example.com', 'sales@person-jsonld.example.com',
  ]);
  const employee = scanned.body.emails.find(item => item.email.startsWith('asha@'));
  assert.equal(employee.verification_status, 'unknown');
  assert.deepEqual(employee.source_evidence[0].contact_points, [{
    contact_type: 'employee', contact_name: 'Asha Menon', contact_title: 'Commercial Director',
  }]);
  const founder = scanned.body.emails.find(item => item.email.startsWith('dev@'));
  assert.deepEqual(founder.source_evidence[0].contact_points, [{
    contact_type: 'founder', contact_name: 'Dev Shah', contact_title: 'Founder',
  }]);
  const sales = scanned.body.emails.find(item => item.email.startsWith('sales@'));
  assert.deepEqual(sales.source_evidence[0].contact_points, [{
    contact_type: 'sales', contact_name: 'Rani Patel', contact_title: 'Regional Sales Manager',
  }]);
  assert.equal(scanned.body.emails.some(item => /(?:unrelated|misattached|support|wrong-type)@/.test(item.email)), false);
  assert.equal(scanned.body.emails.some(item => /(?:first|second)(?:-contact)?@/.test(item.email)), false,
    'duplicate @id definitions remain ambiguous and are not associated');
  assert.ok(fetchCalls.slice(requestStart).every(call => new URL(call.url).hostname === 'person-jsonld.example.com'),
    'JSON-LD @id references are resolved locally without any additional network request');
  const detail = await request(`/api/leads/${jsonLdPersonLeadId}`);
  const html = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(html, /Asha Menon/);
  assert.match(html, /Commercial Director/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(jsonLdPersonLeadId).count, 0);
});

test('scoped Schema.org RDFa captures business and ContactPoint emails without nested leakage', async () => {
  const scanned = await request(`/api/leads/${rdfaLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'nested@rdfa.example.com', 'office@rdfa.example.com', 'sales@rdfa.example.com',
  ]);
  assert.equal(scanned.body.emails.some(item => item.email.startsWith('personnested@')), false,
    'adjacent inline RDFa properties do not concatenate into a false email address');
  const sales = scanned.body.emails.find(item => item.email === 'sales@rdfa.example.com');
  assert.equal(sales.verification_status, 'unknown');
  assert.equal(sales.source_evidence[0].evidence_type, 'website_rdfa');
  assert.deepEqual(sales.source_evidence[0].contact_points, [{
    contact_type: 'sales', contact_name: 'Mina Shah', contact_title: 'Regional Sales Lead',
  }]);
  const nested = scanned.body.emails.find(item => item.email === 'nested@rdfa.example.com');
  assert.deepEqual(nested.source_evidence[0].contact_points, [{
    contact_type: 'sales', contact_name: 'Nested Person', contact_title: null,
  }]);
  assert.equal(scanned.body.emails.some(item => /(?:subsidiary|other)@/.test(item.email)), false);
  const detail = await request(`/api/leads/${rdfaLeadId}`);
  const html = renderLeadDetail({ ...detail.body, tags: [], events: [], customFields: [] });
  assert.match(html, /Mina Shah/);
  assert.match(html, /Regional Sales Lead/);
  assert.equal(detail.body.phone, '+44 20 7946 0132', 'nested person telephone does not replace the business number');
  assert.equal(detail.body.category, 'Industrial automation');
  assert.equal(detail.body.city, 'Pune');
  assert.equal(detail.body.state, 'Maharashtra');
  assert.equal(detail.body.address, '8 Market Road, Pune, Maharashtra, 411001, India');
  assert.match(html, /Industrial automation/);
  assert.match(html, /8 Market Road, Pune, Maharashtra, 411001, India/);
  assert.match(html, /Maharashtra/);
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /RDFa business telephone/);
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /Industrial automation/);
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /8 Market Road/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(rdfaLeadId).count, 0);
});

test('semantic email metadata is retained with evidence while generic metadata and attributes are ignored', async () => {
  const requestStart = fetchCalls.length;
  const scanned = await request(`/api/leads/${metaEmailLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'contact@meta-email.example.com', 'office@meta-email.example.com',
  ]);
  assert.equal(scanned.body.emails.find(item => item.email.startsWith('contact@')).source_evidence.length, 1,
    'duplicate semantic metadata is de-duplicated');
  for (const item of scanned.body.emails) {
    assert.equal(item.verification_status, 'unknown');
    assert.equal(item.source_evidence[0].evidence_type, 'website_meta_email');
    assert.equal(item.source_evidence[0].source_url, 'https://meta-email.example.com/');
    assert.match(item.source_evidence[0].raw_excerpt, /name=/i);
  }
  assert.ok(fetchCalls.slice(requestStart).every(call => new URL(call.url).hostname === 'meta-email.example.com'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(metaEmailLeadId).count, 0);
  const detail = await request(`/api/leads/${metaEmailLeadId}`);
  assert.equal(detail.body.emails.every(item => item.verification_status === 'unknown'), true);
});

test('native non-anchor mailto endpoints are parsed without submitting forms or fetching recipients', async () => {
  const requestStart = fetchCalls.length;
  const scanned = await request(`/api/leads/${mailtoEndpointLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'area2@mailto-endpoints.example.com', 'area@mailto-endpoints.example.com', 'button@mailto-endpoints.example.com',
    'form@mailto-endpoints.example.com', 'link@mailto-endpoints.example.com',
  ]);
  assert.equal(scanned.body.emails.find(item => item.email.startsWith('form@')).source_evidence.length, 1);
  assert.ok(scanned.body.emails.every(item => item.verification_status === 'unknown'
    && item.source_evidence[0].evidence_type === 'mailto'));
  assert.ok(fetchCalls.slice(requestStart).every(call => new URL(call.url).hostname === 'mailto-endpoints.example.com'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(mailtoEndpointLeadId).count, 0);
});

test('public accessibility labels expose strict addresses while private and hidden values stay excluded', async () => {
  const requestStart = fetchCalls.length;
  const scanned = await request(`/api/leads/${accessibleEmailLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.equal(scanned.body.scan.status, 'completed');
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'area@accessible-email.example.com', 'exec@accessible-email.example.com', 'exports@accessible-email.example.com',
    'finance@accessible-email.example.com', 'help@accessible-email.example.com', 'team@accessible-email.example.com',
  ]);
  for (const item of scanned.body.emails) {
    assert.equal(item.verification_status, 'unknown');
    assert.equal(item.source_evidence[0].evidence_type, 'website_accessible_text');
    assert.match(item.source_evidence[0].raw_excerpt, /(?:aria-label|title|alt):/i);
  }
  assert.ok(fetchCalls.slice(requestStart).every(call => new URL(call.url).hostname === 'accessible-email.example.com'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(accessibleEmailLeadId).count, 0);
});

test('explicit public contact email attributes persist while generic and hidden attributes stay excluded', async () => {
  const requestStart = fetchCalls.length;
  const scanned = await request(`/api/leads/${contactAttributeLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  assert.deepEqual(scanned.body.emails.map(item => item.email).sort(), [
    'partnerships@contact-attribute.example.com', 'sales@contact-attribute.example.com',
  ]);
  for (const item of scanned.body.emails) {
    assert.equal(item.verification_status, 'unknown');
    assert.equal(item.source_evidence[0].evidence_type, 'website_contact_attribute');
    assert.match(item.source_evidence[0].raw_excerpt, /data-(?:contact|business)-email:/);
  }
  assert.ok(fetchCalls.slice(requestStart).every(call => new URL(call.url).hostname === 'contact-attribute.example.com'));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(contactAttributeLeadId).count, 0);
});

test('structured telephone discoveries retain operator values and keep source evidence separate', async () => {
  const scanned = await request(`/api/leads/${operatorStructuredPhoneLeadId}/website-email-scan`, 'POST');
  assert.equal(scanned.status, 201);
  const detail = await request(`/api/leads/${operatorStructuredPhoneLeadId}`);
  assert.equal(detail.body.phone, 'Operator supplied phone');
  assert.match(detail.body.profile_source_evidence[0].raw_excerpt, /RDFa business telephone: \+44 20 7946 0132/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sends WHERE lead_id=?').get(operatorStructuredPhoneLeadId).count, 0);
});

test('legacy enrichment helpers make no network requests for bulk discovery or import callers', async () => {
  const { enrichLead, enrichLeadsBatch } = await import('../pipeline/enricher.js');
  const single = await enrichLead({ website_url: 'https://northstar.example.com' });
  assert.deepEqual(single.emails, []);
  assert.match(single.errors[0].error, /one-time public website scan/i);
  const batch = await enrichLeadsBatch([
    { website_url: 'https://one.example.com' }, { website_url: 'https://two.example.com' },
  ]);
  assert.equal(batch.size, 2);
  assert.ok([...batch.values()].every(item => item.emails.length === 0));
});
