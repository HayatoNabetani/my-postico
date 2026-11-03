# My Postico

macOS向けのPostgreSQL・MySQL・MariaDB GUIクライアントです。GUIで組み立てる高機能フィルターとSSHトンネル接続を中心にしています。

## 実装済み

- PostgreSQL / MySQL / MariaDB接続プロファイルの作成・編集・削除（従来の接続設定はPostgreSQLとして継続利用）
- DBパスワード、SSHパスワード、秘密鍵パスフレーズのmacOS Keychain保存
- SSL接続（Disable / Prefer / Require / Verify Full）
- SSHトンネル（パスワード、秘密鍵、SSH Agent）
- SSHホスト鍵のSHA-256フィンガープリント確認と変更検知
- スキーマ、テーブル、ビュー、カラムの読み込み
- 通常テーブルは100行ずつLIMIT / OFFSETで取得してページング
- SQL結果は自動の件数上限なしで全件取得し、タブのメモリに保持して500行ずつ「前へ／次へ」で表示（ページ移動では再実行しない）
- テーブル名・構造画面のカラム名・結果ヘッダーの3段階ソート（降順 → 昇順 → 元の順番）
- 結果カラムの境界ドラッグによる幅変更、ヘッダー名ドラッグによる順番変更（タブごとに保持）
- SQL結果の全取得行のソート、表示順でのスプレッドシートコピーとCSV／JSON出力（カラムの右クリックコピーは表示ページが対象）
- 主キー・外部キーと参照先のカラム表示
- スキーマ単位の読み取り専用ER図、関連テーブル表示、PNG／SVG／Mermaid／draw.io出力
- ダブルクリックによるセル編集と、適用ボタンによる一括反映
- AND / OR、ネスト、型別演算子を備えたフィルタービルダー
- パラメーター化されたフィルターSQL
- クイックフィルター、フィルター保存・復元、SQLプレビュー
- SQLエディタと名前付きクエリー保存
- ブラウザ式の複数テーブルタブ
- DB種類に応じたSQL構文ハイライト、識別子クォート、DDL・メンテナンスSQLテンプレート
- テーブル・ビュー・関数・プロシージャのDDL表示、SQL実行とキャンセル
- MySQL / MariaDBのDECIMAL・大きな整数の精度保持、バイナリの16進数表示
- ウィンドウの移動・リサイズ、サイドバー幅とSQLエディタ高さのドラッグ調整

## 開発

必要な環境:

- Node.js 20以降
- Rust stable
- macOSのXcode Command Line Tools

```bash
npm install
npm run tauri dev
```

フロントエンドだけを確認する場合:

```bash
npm run dev
```

このMac向けのアプリを作成する場合:

```bash
npm run setup:signing # 初回のみ。macOSの証明書設定ダイアログを許可する
npm run build:app
codesign --verify --deep --strict 'src-tauri/target/release/bundle/macos/My Postico.app'
```

生成先は`src-tauri/target/release/bundle/macos/My Postico.app`です。このMacのログインキーチェーンに保存した`My Postico Local Development`証明書で署名します。証明書は再ビルド時も使い回してください。秘密鍵はリポジトリには保存せず、証明書の信頼はユーザー単位のコード署名用途だけに限定します。配布用には`APPLE_SIGNING_IDENTITY`でDeveloper IDの署名IDを指定してください。

### キーチェーンの確認が繰り返し出る場合

以前のアドホック署名では、ビルドごとにアプリの識別情報が変わるため、保存済みパスワードへの「常に許可」が更新後に引き継がれません。同じ証明書で署名したアプリを同じ場所（例: `/Applications/My Postico.app`）にインストールしてください。署名切り替え後、初回の接続でmacOSのログインパスワードを入力して「常に許可」を選びます。保存済みのDB・SSHパスワード等の項目ごとに確認される場合があります。以降、同じ署名での更新では許可を維持できます。

`npm run tauri dev`は配布用の署名済みアプリとは別の実行ファイルです。キーチェーンの許可を維持して普段使いする場合は、上記の署名済みアプリを使用してください。

## 検証

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

検証用PostgreSQLでSQL結果の全件取得も確認する場合:

```bash
MY_POSTICO_TEST_DATABASE_URL='host=localhost dbname=postgres' cargo test --manifest-path src-tauri/Cargo.toml sql_results_preserve_all_rows_and_explicit_limits -- --ignored
```

全DB機能の統合テストは、専用の使い捨てDBで実行してください。テストは一意な名前のスキーマ／データベースを作成・削除します。MySQL系では接続・TLS・キャンセル、カタログ・DDL、フィルターとSQLプレビュー、100行のページング、10,003行のSQL結果、精度を保持した編集、一括変更のロールバック、読み取り専用を検証します。

```bash
MY_POSTICO_TEST_DATABASE_URL='host=localhost dbname=postico_test' cargo test --manifest-path src-tauri/Cargo.toml postgres_ -- --ignored
MY_POSTICO_TEST_MYSQL_URL='mysql://user:password@localhost:3306/postico_test' cargo test --manifest-path src-tauri/Cargo.toml mysql_db::tests:: -- --ignored
```

動作確認済み: PostgreSQL 16、MySQL 8.4、MariaDB 10.5 / 11.4。TLSの統合テストは自己署名証明書またはTLSなしの専用サーバーを前提とします。

MySQL / MariaDBではデータベース名を省略して接続できます。テーブル一覧はデータベース単位で表示され、SQLエディタで修飾なしの名前を使う場合は接続設定にデータベースを指定するか、`USE database_name`を実行してください。SSLのPreferは、サーバーがTLS非対応と応答した場合だけ暗号化なしにフォールバックします。Verify FullはOSが信頼する証明書と接続先ホスト名を検証します（SSH経由でも元のホスト名を使用）。

## 現在の制限

- SQL結果はアプリ起動中のメモリに保持します。再実行で置き換わり、タブを閉じると破棄されます。大量の結果はメモリを使用するため、必要に応じてSQLにLIMITを指定してください。
- 主キーがないテーブルとビューは安全に行を特定できないため編集できません。
- SQLエディタは書き込みSQL・DDLも実行できます。読み取り専用接続では書き込みを拒否します。
- MySQL / MariaDBの一括編集とCSVインポートはInnoDBの通常テーブルに対応します。他のストレージエンジンはSQLエディタから操作してください。
- MySQL / MariaDBのDECIMALとJavaScriptで精度を維持できない整数は文字列として表示・出力します。バイナリ値は`0x`形式で表示・入力します。
- MySQL / MariaDBの複文のストアドルーチンは定義全体を選択して実行してください。CLI専用の`DELIMITER`行は含めません。
- SSHは単一の踏み台サーバーに対応し、多段SSHには未対応です。
- 実際の接続先での認証・証明書・SSH経由の接続は環境ごとに確認してください。

詳細は [プロダクト仕様書](docs/product-spec.md) を参照してください。

## ER図

接続後、画面右上の「ER図」でスキーマ全体を表示します。スキーマの右クリックメニューからも開けます。テーブルを右クリックして「関連テーブルのER図を表示」を選ぶと、そのテーブルと同じスキーマ内の直接の参照元・参照先を中心に表示します。

- 左のチェックで表示・出力対象を選択できます。検索は選択リストのみを絞り込みます。
- 関連テーブルボタン、キーのみ表示、拡大・縮小、全体に合わせる、ドラッグ移動に対応します。
- 「出力」は現在選択しているテーブルとカラムを対象に、スクロール範囲・表示倍率に関係なく図全体を保存します。デスクトップ版ではダウンロードフォルダへ保存し、既存ファイルは上書きしません。
- PNGは資料用の画像、SVGは拡大可能な画像、Mermaid（`.mmd`）はテキスト管理用、draw.io（`.drawio`）はテーブルの枠・参照線を編集できる形式です。Mermaidはflowchart構文でテーブル定義と外部キーを表現します。
- 実際の外部キー制約を使用し、複合外部キー、同じカラム上の複数の制約、自己参照、循環参照を保持します。名前からの関係推測や多重度の推測は行いません。
- 別スキーマへの参照先は破線枠で表示します。別スキーマ側のカラム一覧や参照元は取得しません。ビューの依存関係は対象外です。
- 図からDB定義を変更する機能はありません。行データを読み込まず、外部サービスへDB情報を送信しません。大きすぎる図のPNG出力は、対象を絞るかSVG出力を利用してください。

設計は、[DataGripの図とエクスポート機能](https://www.jetbrains.com/help/datagrip/creating-diagrams.html)を参考にし、[DBeaverの読み取り専用の扱い](https://dbeaver.com/docs/dbeaver/ER-Diagrams/)を取り入れています。これらのアプリやJavaのインストールは不要です。

ER図のDB統合テストは専用の使い捨てDBで実行します。一意なスキーマ／データベースを作成・削除し、複合外部キー・複数制約・外部参照・自己参照・読み取り専用トランザクションを検証します。

```bash
MY_POSTICO_TEST_DATABASE_URL='host=localhost dbname=postico_test' cargo test --manifest-path src-tauri/Cargo.toml diagram::tests::postgres_catalog_diagram -- --ignored
MY_POSTICO_TEST_MYSQL_URL='mysql://user:password@localhost:3306/postico_test' cargo test --manifest-path src-tauri/Cargo.toml diagram::tests::mysql_catalog_diagram -- --ignored
```
