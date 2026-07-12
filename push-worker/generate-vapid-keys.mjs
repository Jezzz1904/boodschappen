// Eenmalig lokaal draaien om een VAPID-sleutelpaar te genereren voor de push-worker.
// Gebruik: cd push-worker && npm install web-push && node generate-vapid-keys.mjs
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('Zet deze drie als secrets op de worker (zie README.md):\n');
console.log('VAPID_PUBLIC_KEY  =', keys.publicKey);
console.log('VAPID_PRIVATE_KEY =', keys.privateKey);
console.log('VAPID_SUBJECT     = mailto:jouw@email.nl   (pas aan naar je eigen e-mailadres)');
