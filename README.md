# Brain AutoSim for Android

The Brain AutoSim desktop app, rebuilt as an Android app. It works the same way: paste or generate alpha expressions, choose settings, then start simulating on WorldQuant BRAIN. Results come in live, with checks and a PnL chart for each alpha. Everything runs on the phone. No computer or Python is needed.

## 1. Get the APK

### Option A: let GitHub build it (nothing to install)

1. Make a free account at github.com, then create a new **private** repository.
2. Upload this whole folder, including the hidden `.github` folder. The easiest ways are GitHub Desktop or
   `git init && git add . && git commit -m "Brain AutoSim" && git branch -M main && git remote add origin <your repo URL> && git push -u origin main`.
   If you use the website's drag-and-drop upload instead, check that `.github/workflows/build-apk.yml` arrived.
   If it didn't, use **Add file > Create new file**, type that path as the name, and paste in the file's contents.
3. Open the repository's **Actions** tab and pick the latest **Build APK** run. After about 5 minutes, download
   **BrainAutoSim-apk** from the bottom of that page. It is a zip that contains `BrainAutoSim.apk`.

### Option B: Android Studio

1. Install Android Studio (free, developer.android.com/studio).
2. Choose **File > Open** and pick this folder. The first sync downloads the Android tools, which takes a few minutes.
3. To build the file, choose **Build > Build App Bundle(s) / APK(s) > Build APK(s)**. The APK lands in `app/build/outputs/apk/`.
   You can also connect your phone with USB debugging turned on and press **Run ▶**.

## 2. Install it on your phone

Copy `BrainAutoSim.apk` to the phone, or download it there directly from GitHub, then tap it. Android asks you to
allow installing apps from that source (your browser or file manager). Allow it once. You need Android 7.0 or newer.

A newer APK built from this project installs over the old one and keeps your saved data, because every build is signed with the same key (see the note at the end).

## 3. Use it

It has the same three steps as the desktop app: **Alphas > Settings > Run**. Use the bottom bar to switch between screens.
To try it without an account, tap **Try the demo**.

What's different on a phone:

| | |
|---|---|
| **Results** | Each row is saved as it arrives. When a run ends, the CSV is copied to **Downloads/BrainAutoSim/** (Android 10+). Use **Save CSV** or **Share** (Gmail, Drive, WhatsApp...) at any time. |
| **Long runs** | While a run is going, a notification shows its progress. The run keeps going with the screen off or in another app. Allow notifications when asked. If your phone still pauses it, set the app's battery use to *Unrestricted* (there's a button under Help). |
| **Biometric check** | If BRAIN asks for it, the link opens in your browser. Finish the check there, come back, and tap **I've done it**. |
| **Back button** | Closes the details panel, then goes back to the alpha list. Leaving the app during a run doesn't stop the run. |
| **Signing in** | When the app is fully closed, you need to sign in again. Tick *remember my password* to make that one tap. Your last run's results stay visible either way. |

## New in 1.1

| | |
|---|---|
| **Check submission / Submit alpha** | Tap any result. **Check submission** runs BRAIN's full pre-submission checks, including self- and production-correlation, and updates the result. **Submit alpha** asks you to confirm, then submits and waits until BRAIN reports the alpha as ACTIVE or names the checks that failed. Submitting can't be undone, and BRAIN limits how many alphas you can submit per day. |
| **Generate with AI** | On the Alphas screen. Use your own key from OpenAI, Anthropic (Claude), Google Gemini or any OpenAI-compatible service (OpenRouter, Groq, DeepSeek, Mistral, xAI, Together…). **Load models** lists what your key can use. Pick the market (region / universe / delay) and the data (category, datasets, field types, coverage), say how many expressions you want, and add an idea if you like. The app sends the AI the real field names and BRAIN operators, asks in batches, drops duplicates and anything that uses a made-up field or operator, and adds the rest to your list. |
| **Super alphas** | Switch the Alphas screen to **Super alphas**. Write selection and combo expressions (one per line) and set selection handling and limit. Every pairing is simulated with your Settings and shows up under Run with a SUPER tag. |
| **Fill for templates** | Each `{placeholder}` has a **Fill** button. You can use a ready-made list (lookback windows, groups, operators…), save and reuse your own lists, or fill it with every field of a BRAIN data category, filtered by dataset, type (MATRIX / VECTOR / GROUP), coverage and popularity. VECTOR fields are wrapped in `vec_avg` (or another vector operator) automatically. Synced fields are saved on the phone and **download again for the new market** when you change Settings. Choose **A random sample** to make any number of expressions from millions of combinations. |

## Privacy

- The app only talks to `api.worldquantbrain.com`, plus the AI service you choose if you use **Generate with AI**. Demo mode only contacts an AI service, and only if you use the AI generator.
- Your AI key is sent only to that service. It is saved only if you tick *Remember the key*. The AI provider charges you for what you use.
- Your settings, alpha list, history and (if you tick the box) your password are kept in the app's private storage, which other apps can't read. They are also excluded from cloud backups.
- Permissions: Internet, plus notifications, foreground service and wake lock, which are used only while a run is going.

## How it's built

| File | What it is |
|---|---|
| `app/src/main/assets/www/engine.js` | A port of `brain_autosim.py` to JavaScript: the BRAIN API client (sign-in, biometric step, session refresh, retries, waiting at the parallel limit, multi-simulation, check and submit), regular and super-alpha runs, the worker pool, the demo backend, history, CSV and run state. Also the data-field catalog (sync and cache) and the AI generator (OpenAI, Anthropic, Gemini and OpenAI-compatible formats). |
| `app/src/main/assets/www/index.html` | The desktop UI, adapted for phones (bottom navigation, results as cards, Save/Share). It switches back to the table layout on tablets. |
| `app/src/main/assets/www/platform.js` | Connects the page to Android, or to plain browser APIs when it isn't running inside the app. |
| `app/src/main/java/.../MainActivity.java` | The WebView host: system-bar insets, file picker for *Import file*, dialogs, back button. |
| `.../NativeBridge.java` | Network calls (OkHttp, so there are no browser CORS limits), timers that keep running in the background, private files, Downloads, the share sheet and the clipboard. |
| `.../RunService.java` | The progress notification that keeps a run alive with the screen off. |
| `.../ShareProvider.java` | Hands a results file to the app you share it with. |

**Try the UI in a desktop browser:** open `app/src/main/assets/www/index.html` in Chrome and choose *Try the demo*. Real sign-in only works inside the app, because browsers block calls to the BRAIN API from other sites.

**Signing key:** `app/brainautosim.keystore` (password `brainautosim`) signs every build. That's why updates install over each other. This is fine for your own phone. Before you publish the app anywhere, make your own key and change `signingConfigs` in `app/build.gradle`.

Build setup: Android Gradle Plugin 8.7.3, Gradle 8.10.2, compile/target SDK 35, min SDK 24, Java 11, one dependency (OkHttp 4.12).
