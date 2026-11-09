# StoreX for Windows

تطبيق StoreX لسطح المكتب باستخدام Electron وSQLite، مع واجهة عربية مبنية على HTML/CSS/JavaScript.

## الأنظمة المستهدفة
- Windows 10 (64-bit)
- Windows 11 (64-bit)

## المتطلبات
- Node.js LTS (يفضل 20 أو أحدث)
- اتصال إنترنت عند تثبيت الحزم أول مرة.

## التشغيل أثناء التطوير
افتح PowerShell داخل مجلد المشروع:

```powershell
npm install
npm start
```

## إنشاء EXE Installer

```powershell
npm run build:win
```

سيظهر ملف التثبيت داخل `release`.

## قاعدة البيانات والتوافق
تُحفظ قاعدة البيانات باسم `storex.sqlite` داخل مجلد بيانات المستخدم الذي يحدده `app.getPath('userData')`، والصور في مجلد `images` المجاور لها. يختلف المسار النهائي بحسب اسم التطبيق وإعداد Windows. لا تُحفظ بيانات المتجر في مجلد التثبيت أو بجانب ملف EXE.

المخطط الأساسي متوافق مع قاعدة Android `mystore.db`:

- `products(id,name,category,barcode,costUsd,costSyp,sellUsd,sellSyp,image)`
- `categories(name)`
- `settings(key,value)` وتُستخدم المفاتيح `rate` و`rateUpdatedAt`.

يتم الحفاظ على منطق Android عند استيراد البيانات: إضافة الفئات دون حذف القديمة، وتحديث المنتج الذي يطابق الاسم، وإضافة المنتجات الجديدة، دون مسح بيانات قاعدة Windows الحالية. وعند تحديث سعر السوق يُعاد حساب القيم المقابلة بالليرة اعتماداً على سعر الصرف السابق.

## النسخ الاحتياطية
يصدر التطبيق ZIP يحتوي `backup.json` في الجذر ومجلد `images/`. هذا التنسيق متوافق مع مستورد Android الوارد في كود MainActivity المرسل. كما يتضمن `storex-backup.json` للتوافق مع أول نموذج Windows. يستطيع التطبيق استيراد ملفات Android القديمة التي تحتوي `backup.json` وصور `images/`، كما يستورد نسخ Windows السابقة.

## عدم استخدام تخزين المتصفح
لا يستخدم التطبيق `localStorage` أو `sessionStorage` أو `IndexedDB`. جميع بيانات المنتجات والفئات والإعدادات تُقرأ وتُكتب عبر Preload/IPC إلى SQLite. الوصول إلى الملفات والصور والنسخ الاحتياطية يتم في عملية Electron الرئيسية.

## الأمان
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- واجهة Preload محدودة بالعمليات المطلوبة فقط.

## ملاحظات الإصدار
- واجهة HTML الحالية ما زالت تعتمد على بعض مكتبات وخطوط CDN؛ يلزم اتصال إنترنت لتحميلها ما لم تُضمّن محلياً لاحقاً.
- تم ضبط جلب سعر السوق ليتبع بنية الاستجابة المحددة في كود Android: `marketRates` ثم عنصر `currency=USD` ثم `sell`، مع الضرب في 100.
- ملف EXE يحتاج إلى بنائه على Windows بالأمر أعلاه؛ لم يتم ادعاء إنشاء Installer دون تنفيذ البناء واختباره على Windows.
