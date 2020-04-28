////////////////////////////////////////////////////////////////////////////
//
// Copyright 2020 Realm Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////

import puppeteer from "puppeteer";
import WebpackDevServer from "webpack-dev-server";
import webpack from "webpack";
import { MochaRemoteServer } from "mocha-remote";

import { importRealmApp } from "./import-realm-app";

import WEBPACK_CONFIG = require("../webpack.config");

const devtools = "DEV_TOOLS" in process.env;

/* eslint-disable no-console */

async function run() {
    let devServer: WebpackDevServer | null = null;
    let mochaServer: MochaRemoteServer | null = null;
    let browser: puppeteer.Browser | null = null;

    async function shutdown() {
        if (browser && !devtools) {
            await browser.close();
        }
        // Shut down the Mocha remote server
        if (mochaServer) {
            await mochaServer.stop();
        }
        // Shut down the dev server
        await new Promise(resolve =>
            devServer ? devServer.close(resolve) : resolve(),
        );
    }

    process.once("exit", () => {
        shutdown().then(null, err => {
            console.error(`Error shutting down: ${err}`);
        });
    });

    // Prepare
    const { appId, baseUrl } = await importRealmApp();
    // Start up the Webpack Dev Server
    const compiler = webpack({
        ...(WEBPACK_CONFIG as webpack.Configuration),
        mode: "development",
        plugins: [
            ...WEBPACK_CONFIG.plugins,
            new webpack.DefinePlugin({
                APP_ID: JSON.stringify(appId),
                // Uses the webpack dev servers proxy
                BASE_URL: JSON.stringify("http://localhost:8080"),
            }),
        ],
    });
    await new Promise((resolve, reject) => {
        devServer = new WebpackDevServer(compiler, {
            proxy: { "/api": baseUrl },
        });
        devServer.listen(8080, "localhost", err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
    // Start the mocha remote server
    mochaServer = new MochaRemoteServer();
    // Start up the browser, running the tests
    browser = await puppeteer.launch({ devtools });
    // Navigate to the pages served by the webpack dev server
    const page = await browser.newPage();
    await page.goto("http://localhost:8080");
    // Start running the remote tests
    await mochaServer.runAndStop();
}

run().then(
    () => {
        if (!devtools) {
            process.exit(0);
        }
    },
    err => {
        console.error(err);
        if (!devtools) {
            process.exit(1);
        }
    },
);