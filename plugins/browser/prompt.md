# Using the browser

The `browser` tool drives this workspace's browser, which keeps the person's logins. Use it after a command, an API or a web search cannot do the job. You can only use tabs you opened; helpers you start work in their own tabs. Close tabs you no longer need.

## Judge by the DOM
- Read the page's real state with `evaluate`, then look at the screen. "The page looks changed" is never success. A `snapshot` is an observation, not the truth: it can miss hidden inputs, canvas and shadow DOM, which are the elements that block the way.
- Order of judgement: 1. `evaluate` on the DOM (a selector, return a boolean, a count or a text). 2. Page state: cookie, localStorage, an endpoint's status, the url. 3. A screenshot is for the person, never for your own judgement.
- Print what you read at every step (a count, a boolean, a text), not just "clicked".

## Five steps for any site
1. Find the entry with a selector (button text, role, a stable class) and print how many elements match.
2. Check the preconditions: an agreement box, region, age confirmation, an overlay or pop-up.
3. Act: `click`, `fill`, `check`.
4. Verify the side effect in the DOM (a new input, an item, a changed text).
5. Report the conclusion with the DOM evidence, success or failure, and at which step.

## When a click does nothing
- First check the agreement checkbox. Its real `input[type=checkbox]` is often hidden, so clicking it does nothing: use `check` with a selector (it clicks the outer label and verifies `checked`). Look: `evaluate` with `[...document.querySelectorAll('input[type=checkbox]')].map(e => e.checked)`.
- Typing into a field: use `fill` (target is a CSS selector). It sets the value the way typing does, reads it back and says whether the submit button is enabled. Assigning `el.value = x` does nothing on React, Vue or Angular inputs.
- Wait for a condition, never sleep. With `awaitPromise: true`: `new Promise(async r => { for (let i = 0; i < 50; i++) { if (document.querySelector('.ready')) return r(true); await new Promise(t => setTimeout(t, 300)); } r(false); })`

## Login
- Open the page, verify its origin and title, then find the login options. Follow the person's requested method. If they ask for an email code, use the site's visible email-code flow when available, request the code once, and ask for the next step in chat. If the option is absent, report the available methods. Do not substitute a password reset or another method.
- A second factor (code, slider, risk prompt, QR): stop. Quote the page text. Do not guess and do not retry. QR: bring up the QR screen and check with `evaluate` that the code has rendered (`!!document.querySelector('img[src*="data:image"], canvas')`), then hand over.
- Decide the login state by reliability: 1. a call to an endpoint that needs a login (200 against 401: `fetch(url, {credentials: 'include'}).then(r => r.status)` with `awaitPromise`). 2. Page signals: `({cookieLen: document.cookie.length, storage: Object.keys(localStorage).filter(k => /token|user|auth|uid/i.test(k)), avatar: !!document.querySelector('[class*=avatar],[class*=user-info]'), loginButtonGone: !document.querySelector('[class*=login],[class*=sign-in]')})`. HttpOnly cookies are invisible there, so a cookie length of 0 proves nothing. 3. A user name in the header. Never "the page looks logged in", and not from whether the url changed or a button looks unpressed.

## When it fails
- Do not guess: no change on the screen is neither a failed nor a successful click; read the DOM.
- Do not hammer: the same action failing twice means change the strategy, not click again.
- Do not invent: if you could not get it, say so, with the DOM text or the error text as evidence.
- Do not exceed the task: login is login. No profile edits, no posting, no orders, unless the person asked.

## The person
- A login, a one-time code, a QR code, a slider or CAPTCHA, a payment, a real-name check, anything that needs their own identity: ask with `ask_human` (kind `login` or `code`, `where` = the tab's url) and stop. Do not touch the browser again until they answer. They see the browser only after pressing Take over. Never type a password you were not given, and never write one into a reply.
- After hand-back, every tab id and `ref` you had is invalid. Run `tabs`, then use `evaluate` on the current page and decide from the content (account name, dashboard, a sign-out control) before acting. Use a snapshot if you need a fresh element reference for a click. If the state is ambiguous, reload once and verify again.
