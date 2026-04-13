param(
  [string]$SdkRoot = "C:\Users\juanp\AppData\Local\Android\Sdk",
  [string]$JavaHome = "C:\Program Files\Microsoft\jdk-17.0.18.8-hotspot",
  [string]$ProjectRoot = "C:\RouterFarm\android\routerfarm-ip-helper",
  [string]$OutputApk = "C:\RouterFarm\config\routerfarm-ip-helper.apk"
)

$ErrorActionPreference = "Stop"

$androidJar = Join-Path $SdkRoot "platforms\android-35\android.jar"
$aapt2 = Join-Path $SdkRoot "build-tools\35.0.0\aapt2.exe"
$zipalign = Join-Path $SdkRoot "build-tools\35.0.0\zipalign.exe"
$apksigner = Join-Path $SdkRoot "build-tools\35.0.0\apksigner.bat"
$d8 = Join-Path $SdkRoot "build-tools\35.0.0\d8.bat"
$javac = Join-Path $JavaHome "bin\javac.exe"
$jar = Join-Path $JavaHome "bin\jar.exe"
$keytool = Join-Path $JavaHome "bin\keytool.exe"

foreach ($path in @($androidJar, $aapt2, $zipalign, $apksigner, $d8, $javac, $jar, $keytool)) {
  if (-not (Test-Path $path)) {
    throw "Missing required build tool: $path"
  }
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:Path = "$($JavaHome)\bin;$env:Path"

$buildRoot = Join-Path $ProjectRoot "build"
$classesDir = Join-Path $buildRoot "classes"
$dexDir = Join-Path $buildRoot "dex"
$unsignedApk = Join-Path $buildRoot "routerfarm-ip-helper-unsigned.apk"
$alignedApk = Join-Path $buildRoot "routerfarm-ip-helper-aligned.apk"
$keystorePath = Join-Path $ProjectRoot "routerfarm-ip-helper.keystore"

if (Test-Path $buildRoot) {
  Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $classesDir | Out-Null
New-Item -ItemType Directory -Force -Path $dexDir | Out-Null

$sourceFiles = Get-ChildItem -Path (Join-Path $ProjectRoot "src") -Recurse -Filter *.java | ForEach-Object { $_.FullName }
if (-not $sourceFiles) {
  throw "No helper app source files found in $ProjectRoot\src"
}

& $javac -encoding UTF-8 -source 8 -target 8 -cp $androidJar -d $classesDir $sourceFiles
if ($LASTEXITCODE -ne 0) {
  throw "javac failed."
}

$classFiles = Get-ChildItem -Path $classesDir -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& $d8 --lib $androidJar --output $dexDir $classFiles
if ($LASTEXITCODE -ne 0) {
  throw "d8 failed."
}

& $aapt2 link --manifest (Join-Path $ProjectRoot "AndroidManifest.xml") -I $androidJar --min-sdk-version 24 --target-sdk-version 35 -o $unsignedApk
if ($LASTEXITCODE -ne 0) {
  throw "aapt2 link failed."
}

Push-Location $dexDir
try {
  & $jar uf $unsignedApk classes.dex
  if ($LASTEXITCODE -ne 0) {
    throw "jar update failed."
  }
} finally {
  Pop-Location
}

& $zipalign -f 4 $unsignedApk $alignedApk
if ($LASTEXITCODE -ne 0) {
  throw "zipalign failed."
}

if (-not (Test-Path $keystorePath)) {
  & $keytool -genkeypair -keystore $keystorePath -storepass android -keypass android -alias routerfarmdebug -dname "CN=RouterFarm Debug,O=RouterFarm,L=Local,S=NA,C=US" -keyalg RSA -keysize 2048 -validity 3650
  if ($LASTEXITCODE -ne 0) {
    throw "keytool failed while creating the helper app keystore."
  }
}

& $apksigner sign --ks $keystorePath --ks-key-alias routerfarmdebug --ks-pass pass:android --key-pass pass:android --out $OutputApk $alignedApk
if ($LASTEXITCODE -ne 0) {
  throw "apksigner failed."
}

& $apksigner verify --verbose $OutputApk
if ($LASTEXITCODE -ne 0) {
  throw "Signed APK verification failed."
}

Write-Output $OutputApk
