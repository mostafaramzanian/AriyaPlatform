const http = require('http');
const url = 'http://localhost:3001/api/v1/docs-json';
http.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try {
      const doc = JSON.parse(data);
      const paths = Object.keys(doc.paths || {}).sort();
      console.log('STATUS', res.statusCode);
      console.log('PATH_COUNT', paths.length);
      paths.forEach(p => {
        const methods = Object.keys(doc.paths[p]).map(m => m.toUpperCase()).join(',');
        console.log(`${methods} ${p}`);
      });
    } catch (err) {
      console.error('PARSE_ERROR', err.message);
      console.log(data.substring(0, 2000));
    }
  });
}).on('error', (e) => console.error('REQ_ERROR', e.message));