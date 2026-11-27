// The demo's syntax worker: parses the languages the demo uses.
import {htmlLanguage} from "@codemirror/lang-html"
import {javascriptLanguage} from "@codemirror/lang-javascript"
import {serveSyntax} from "../src/worker"

serveSyntax([javascriptLanguage, htmlLanguage])
