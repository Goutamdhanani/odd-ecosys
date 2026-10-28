// Frozen f30490b syntax parser used only to reproduce the historical input defect.
import { domainToASCII } from 'node:url';
export function validateSyntax(email) {
  const originalEmail = typeof email === 'string' ? email : null;
  const trimmedEmail = originalEmail?.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '') ?? '';
  const normalization = [];
  if (originalEmail !== null && trimmedEmail !== originalEmail) normalization.push('trimmed_outer_whitespace');

  const invalid = (reason, username = null, domain = null) => ({
    is_valid_syntax: false,
    originalEmail,
    normalizedEmail: null,
    normalization,
    username,
    domain,
    asciiDomain: null,
    requiresSmtpUtf8: false,
    reason,
  });

  if (!trimmedEmail || !trimmedEmail.includes('@')) return invalid('missing_at_symbol');
  const at = trimmedEmail.indexOf('@');
  if (at !== trimmedEmail.lastIndexOf('@')) return invalid('multiple_at_symbols');

  const username = trimmedEmail.slice(0, at);
  const inputDomain = trimmedEmail.slice(at + 1);
  if (!username) return invalid('empty_local_part', username, inputDomain || null);
  if (!inputDomain) return invalid('empty_domain', username, null);

  const localBytes = Buffer.byteLength(username, 'utf8');
  if (localBytes > 64) return invalid('local_part_too_long', username, inputDomain);

  const isUtf8NonAscii = char => {
    const codePoint = char.codePointAt(0);
    return codePoint > 0x7f && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  };
  const isAtextCharacter = char => /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]$/.test(char);
  let validLocal = false;
  if (username.startsWith('"') || username.endsWith('"')) {
    if (username.length >= 2 && username.startsWith('"') && username.endsWith('"')) {
      const quoted = username.slice(1, -1);
      validLocal = true;
      const quotedCharacters = [...quoted];
      for (let index = 0; index < quotedCharacters.length; index++) {
        const char = quotedCharacters[index];
        const code = char.codePointAt(0);
        if (char === '\\') {
          const escaped = quotedCharacters[++index];
          if (!escaped || (escaped.codePointAt(0) < 0x20 || escaped.codePointAt(0) > 0x7e)) {
            validLocal = false;
            break;
          }
        } else if (code < 0x20 || code === 0x7f || char === '"' || (code > 0x7f && !isUtf8NonAscii(char))) {
          validLocal = false;
          break;
        }
      }
    }
  } else {
    const atoms = username.split('.');
    validLocal = atoms.every(atom => atom.length > 0 && [...atom].every(char =>
      isAtextCharacter(char) || isUtf8NonAscii(char)));
  }
  if (!validLocal) return invalid('bad_local_part', username, inputDomain);

  // SMTP uses DNS A-labels. Convert U-labels for lookups while keeping the local part untouched.
  const asciiDomain = domainToASCII(inputDomain);
  if (!asciiDomain) return invalid('invalid_idn_domain', username, inputDomain);
  const domain = asciiDomain.toLowerCase();
  const labels = domain.split('.');
  if (domain.length > 253) return invalid('domain_too_long', username, domain);
  if (labels.some(label => label.length > 63)) return invalid('domain_label_too_long', username, domain);
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    return invalid('bad_domain_syntax', username, domain);
  }

  const normalizedEmail = `${username}@${domain}`;
  if (Buffer.byteLength(normalizedEmail, 'utf8') > 254) return invalid('address_too_long', username, domain);
  if (domain !== inputDomain) {
    normalization.push(/[^\x00-\x7f]/u.test(inputDomain) ? 'idn_domain_to_ascii' : 'lowercased_domain');
  }
  return {
    is_valid_syntax: true,
    originalEmail,
    normalizedEmail,
    normalization,
    username,
    domain,
    asciiDomain: domain,
    requiresSmtpUtf8: /[^\x00-\x7f]/.test(username),
    providerConstraints: 'not_inferred_from_syntax',
  };
}


// ═ Frozen reproduction ends here.
