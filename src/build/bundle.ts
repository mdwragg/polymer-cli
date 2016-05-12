/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

import * as dom5 from 'dom5';
import * as gulpif from 'gulp-if';
import * as path from 'path';
import {Transform} from 'stream';
import File = require('vinyl');

import {Logger} from './logger';
import {compose} from './streams';
import {StreamResolver} from './stream-resolver';
import {VulcanizeTransform} from './vulcanize';
import {Analyzer, Loader} from 'hydrolysis';

// non-ES module
const minimatchAll = require('minimatch-all');
const through = require('through2').obj;
const Vulcanize = require('vulcanize');

export class Bundler {

  root: string;
  shell: string;
  sharedBundlePath: string;
  sharedBundleUrl: string;
  allEntrypoints: string[];

  streamResolver: StreamResolver;
  loader: Loader;
  bundle: Transform;
  vulcanize: Transform;
  analyzer: Analyzer;
  entrypointFiles: Map<string, File>;
  sharedFile: File;

  _verboseLogging = false;

  _entrypointToDepsResolve: (value: Map<string, string[]>) => void;
  _entrypointToDeps: Promise<Map<string, string[]>>;

  constructor(root: string, shell: string, entrypoints?: string[]) {
    this.root = root;
    this.shell = shell;
    this._entrypointToDeps = new Promise<Map<string, string[]>>((resolve) => {
      this._entrypointToDepsResolve = resolve;
    })
    this.sharedBundlePath = 'shared-bundle.html';
    this.sharedBundleUrl = path.resolve(root, this.sharedBundlePath);

    let _allEntrypoints = [];
    // It's important that shell is first for document-ordering of imports
    if (shell) _allEntrypoints.push(shell);
    this.allEntrypoints =
        Array.prototype.concat.apply(_allEntrypoints, entrypoints);

    this.streamResolver = new StreamResolver({
        entrypoints: this.allEntrypoints,
        basePath: root,
        root: root,
        redirect: 'bower_components/',
      });

    this.loader = new Loader();
    this.loader.addResolver(this.streamResolver);
    this.analyzer = new Analyzer(false, this.loader);

    this.vulcanize = new VulcanizeTransform({
      fsResolver: this.streamResolver,
      inlineScripts: true,
      inlineCss: true,
      stripComments: true,
    });

    this.entrypointFiles = new Map();

    let throughStream = through((file, enc, cb) => {
      if (this.isEntryPoint(file.path)) {
        // don't pass on any entrypoints until the stream has ended
        this.entrypointFiles.set(file.path, file);
        cb();
      } else {
        cb(null, file);
      }
    },
    (done) => {
      this._buildBundles().then((bundles: Map<string, string>) => {
        for (let entrypoint of this.entrypointFiles.keys()) {
          let file = this.entrypointFiles.get(entrypoint);
          let contents = bundles.get(entrypoint);
          file.contents = new Buffer(contents);
          throughStream.push(file);
        }
        let sharedBundle = bundles.get(this.sharedBundleUrl);
        if (sharedBundle) {
          let contents = bundles.get(this.sharedBundleUrl);
          this.sharedFile.contents = new Buffer(contents);
          throughStream.push(this.sharedFile);
        }
        // end the stream
        done();
      });
    });

    this.bundle = compose([
      this.streamResolver,
      throughStream
    ]);
  }

  isEntryPoint(url: string): boolean {
    return minimatchAll(url, this.allEntrypoints, {matchBase: true});
  }

  _buildBundles(): Promise<Map<string, string>> {
    return this._getBundles().then((bundles) => {
      if (this._verboseLogging) {
        console.log('bundles:');
        for (let url of bundles.keys()) {
          let deps = bundles.get(url);
          if (!deps) {
            console.log('    no deps?');
          } else {
            console.log(`  ${url} (${deps.length}):`);
            for (let dep of deps) {
              console.log(`    ${dep}`);
            }
          }
        }
      }

      let sharedDepsBundle = this.shell || this.sharedBundleUrl;
      let sharedDeps = bundles.get(sharedDepsBundle);
      let promises = [];

      if (this.shell) {
        let shellFile = this.streamResolver._files.get(this.shell);
        console.assert(shellFile != null);
        let newShellContent = this._addSharedImportsToShell(bundles);
        shellFile.contents = new Buffer(newShellContent);
      }

      for (let entrypoint of this.allEntrypoints) {
        let addedImports = (entrypoint == this.shell || !this.shell)
            ? []
            : [path.relative(path.dirname(entrypoint), sharedDepsBundle)]
        let excludes = (entrypoint == this.shell)
            ? []
            : sharedDeps.concat(sharedDepsBundle);

        promises.push(new Promise((resolve, reject) => {
          var vulcanize = new Vulcanize({
            abspath: null,
            fsResolver: this.streamResolver,
            addedImports: addedImports,
            stripExcludes: excludes,
            inlineScripts: true,
            inlineCss: true,
            inputUrl: entrypoint,
          });
          vulcanize.process(null, (err, doc) => {
            if (err) {
              reject(err);
            } else {
              if (this._verboseLogging) {
                console.log(`vulcanized doc for ${entrypoint}: ${doc.length}`);
              }
              resolve({
                url: entrypoint,
                contents: doc,
              });
            }
          });
        }));
      }
      // vulcanize the shared bundle
      if (!this.shell && sharedDeps) {
        promises.push(this._generateSharedBundle(sharedDeps));
      }

      return Promise.all(promises).then((bundles) => {
        // convert {url,contents}[] into a Map
        let contentsMap = new Map();
        for (let bundle of bundles) {
          contentsMap.set(bundle.url, bundle.contents);
        }
        return contentsMap;
      });
    });
  }

  _addSharedImportsToShell(bundles: Map<string, string[]>): string {
    console.assert(this.shell != null);
    let shellDeps = bundles.get(this.shell)
        .map((d) => path.relative(path.dirname(this.shell), d));

    let file = this.streamResolver._files.get(this.shell);
    console.assert(file != null);
    let contents = file.contents.toString();
    let doc = dom5.parse(contents);
    let imports = dom5.queryAll(doc, dom5.predicates.AND(
      dom5.predicates.hasTagName('link'),
      dom5.predicates.hasAttrValue('rel', 'import')
    ));

    // Remove all imports that are in the shared deps list so that we prefer
    // the ordering or shared deps. Any imports left should be independent of
    // ordering of shared deps.
    let shellDepsSet = new Set(shellDeps);
    for (let _import of imports) {
      if (shellDepsSet.has(dom5.getAttribute(_import, 'href'))) {
        dom5.remove(_import);
      }
    }

    // Append all shared imports to the end of <head>
    let head = dom5.query(doc, dom5.predicates.hasTagName('head'));
    for (let dep of shellDeps) {
      let newImport = dom5.constructors.element('link');
      dom5.setAttribute(newImport, 'rel', 'import');
      dom5.setAttribute(newImport, 'href', dep);
      dom5.append(head, newImport);
    }
    let newContents = dom5.serialize(doc);
    return newContents;
  }

  _generateSharedBundle(sharedDeps: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      let contents = sharedDeps
          .map((d) => {
            console.assert(d.startsWith(this.root));
            let url = d.substring(this.root.length);
            return `<link rel="import" href="${url}">`;
          })
          .join('\n');

      if (this._verboseLogging) {
        console.log('shared-bundle.html:\n', contents);
      }

      this.sharedFile = new File({
        cwd: this.root,
        base: this.root,
        path: this.sharedBundleUrl,
        contents: new Buffer(contents),
      });

      // make the shared bundle visible to vulcanize
      this.streamResolver.addFile(this.sharedFile);

      var vulcanize = new Vulcanize({
        abspath: null,
        fsResolver: this.streamResolver,
        inlineScripts: true,
        inlineCss: true,
        inputUrl: this.sharedBundleUrl,
      });
      vulcanize.process(null, (err, doc) => {
        if (err) {
          reject(err);
        } else {
          resolve({
            url: this.sharedBundleUrl,
            contents: doc,
          });
        }
      });
    });
  }

  _getBundles() {
    return this._getDepsToEntrypointIndex().then((indexes) => {
      let depsToEntrypoints = indexes.depsToEntrypoints;
      let entrypointToDeps = indexes.entrypointToDeps;
      let bundles = new Map<string, string[]>();

      let addImport = (from: string, to: string) => {
        let imports;
        if (!bundles.has(from)) {
          imports = [];
          bundles.set(from, imports);
        } else {
          imports = bundles.get(from);
        }
        if (!imports.includes(to)) {
          imports.push(to);
        }
      }

      // We want to collect dependencies that appear in > 1 entrypoint, but
      // we need to collect them in document order, so rather than iterate
      // directly through each dependency in depsToEntrypoints, we iterate
      // through entrypoints in entrypointToDeps, which has dependencies in
      // order for each entrypoint. Then we iterate through dependencies for
      // each entrypoint and look up how many entrypoints depend on it.
      // This assumes an ordering between entrypoints, since they could have
      // conflicting orders between their top level imports. The shell should
      // always come first.
      for (let entrypoint of entrypointToDeps.keys()) {
        let dependencies = entrypointToDeps.get(entrypoint);
        for (let dep of dependencies) {
          let entrypointCount = depsToEntrypoints.get(dep).length;
          if (entrypointCount > 1) {
            if (this.shell) {
              addImport(this.shell, dep);
              // addImport(entrypoint, this.shell);
            } else {
              addImport(this.sharedBundleUrl, dep);
              addImport(entrypoint, this.sharedBundleUrl);
            }
          } else {
            addImport(entrypoint, dep);
          }
        }
      }
      return bundles;
    });
  }

  _getDepsToEntrypointIndex() {
    // TODO: tsc is being really weird here...
    let depsPromises = <Promise<string[]>[]>this.allEntrypoints.map(
        (e) => this._getDependencies(e));

    return Promise.all(depsPromises).then((value: any) => {
      // tsc was giving a spurious error with `allDeps` as the parameter
      let allDeps: string[][] = <string[][]>value;

      // An index of dependency -> entrypoints that depend on it
      let depsToEntrypoints = new Map<string, string[]>();

      // An index of entrypoints -> dependencies
      let entrypointToDeps = new Map<string, string[]>();

      console.assert(this.allEntrypoints.length === allDeps.length);

      for (let i = 0; i < allDeps.length; i++) {
        let entrypoint = this.allEntrypoints[i];
        let deps: string[] = allDeps[i];
        console.assert(deps != null, `deps is null for ${entrypoint}`);

        entrypointToDeps.set(entrypoint, deps);

        for (let dep of deps) {
          let entrypointList;
          if (!depsToEntrypoints.has(dep)) {
            entrypointList = [];
            depsToEntrypoints.set(dep, entrypointList);
          } else {
            entrypointList = depsToEntrypoints.get(dep);
          }
          entrypointList.push(entrypoint);
        }
      }

      this._entrypointToDepsResolve(entrypointToDeps);
      return {
        depsToEntrypoints,
        entrypointToDeps,
      };
    });
  }

  /**
   * Attempts to retreive document-order transitive dependencies for `url`.
   */
  _getDependencies(url: string): Promise<string[]> {
    let visited = new Set();
    let list = [];

    // async depth-first traversal: waits for document load, then async iterates
    // on dependencies. No return values are used, writes to visited and list.
    //
    // document.depHrefs is _probably_ document order, if all html imports are
    // at the same level in the tree.
    // See: https://github.com/Polymer/hydrolysis/issues/240
    let _getDeps = (url: string) =>
      this.analyzer.load(url).then((d) => _iterate(d.depHrefs.values()));

    // async iteration: waits for _getDeps on a value to return before recursing
    // to call _getDeps on the next value.
    let _iterate = (iterator: Iterator<string>) => {
      let next = iterator.next();
      if (next.done || visited.has(next.value)) {
        return Promise.resolve();
      } else {
        list.push(next.value);
        visited.add(url);
        return _getDeps(next.value).then((_) => _iterate(iterator));
      }
    }

    // kick off the traversal from root, then resolve the list of dependencies
    return _getDeps(url).then((_) => {
      return list;
    });
  };

}