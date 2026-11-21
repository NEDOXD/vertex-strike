# Vertex Strike Online: deploy on Render

1. Create a new GitHub repo and upload everything in this folder
   (index.html, server.js, package.json, render.yaml, .gitignore).
2. On render.com: New + > Blueprint > pick the repo > Apply.
   (Or New + > Web Service: Runtime Node, Build Command empty, Start Command `node server.js`.)
3. When it's live, open https://YOUR-APP.onrender.com and play.
   Friends use the same URL, or the invite link shown in the room lobby.

Notes
- Free plan sleeps after ~15 min idle; the first visit afterwards takes ~30-60 s to wake.
  Rooms are kept in memory, so they reset when the server sleeps or restarts.
- Render provides HTTPS, and the game switches to wss:// automatically.
- Local test: `node server.js` then open http://localhost:3000
