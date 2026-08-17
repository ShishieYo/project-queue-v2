// firebase-config.js
// Paste your project's config here: Firebase Console → ⚙ Project settings →
// scroll to "Your apps" → the web app (</>) → SDK setup and configuration.
// This file must sit in the same folder as the other HTML/JS files, and all
// of them load it with <script type="module">.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD0uGsRuUcL0kaDRodA-1JVfoEd923qY4g",
  authDomain: "prc-region3-queue.firebaseapp.com",
  projectId: "prc-region3-queue",
  storageBucket: "prc-region3-queue.firebasestorage.app",
  messagingSenderId: "1012002607517",
  appId: "1:1012002607517:web:d5d291188d81a91acf5f74"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
