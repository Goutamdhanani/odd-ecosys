// Stub the documented identity and empty-address contract before recipient data.
export function reacherContractFixture(result) {
  return async (input, init = {}) => {
    if (new URL(input).pathname === '/version') return new Response(JSON.stringify({ version: '0.9.1' }));
    const email = JSON.parse(init.body || '{}').to_email;
    if (email === '') return new Response(JSON.stringify({ error: 'to_email field is required.' }), { status: 400 });
    return new Response(JSON.stringify(typeof result === 'function' ? result(email) : result));
  };
}
