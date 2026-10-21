// QA TEMPORÁRIO (só na cópia de teste do WP-04, NUNCA commitado): expõe services/crypto em window.
import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

let started = false;
function start(set) {
  if (started || typeof window === 'undefined') return;
  started = true;
  import('../services/crypto')
    .then((m) => { window.__e2ee5 = m; set && set('ready'); })
    .catch((e) => { window.__e2ee5_err = String(e && e.message); set && set('err'); });
}
if (typeof window !== 'undefined' && window.__e2ee5_qa_boot) start(null);

export default function E2ee5Qa() {
  const [s, setS] = useState('loading');
  useEffect(() => { start(setS); if (window.__e2ee5) setS('ready'); }, []);
  return (<View style={{ padding: 20 }}><Text testID="e2ee5-qa">{'e2ee5-qa:' + s}</Text></View>);
}
