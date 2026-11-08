import { encode } from 'uqr';

window.jianjianQr = text => encode(String(text), { ecc: 'M', border: 2 });
