var express = require('express');
var bodyParser = require('body-parser');
var path = require('path');
var request = require('request');
var rp = require('request-promise');
var cheerio = require('cheerio');
var levelup = require('level');
var app     = express();

// Utilities
var DbInterface = require('./utils').DbInterface;
var stringToArr = require('./utils').stringToArr;
var invertedToArr = require('./utils').invertedToArr;
var wordsToStemmed = require('./utils').wordsToStemmed;
var wordsToPosTable = require('./utils').wordsToPosTable;
var queryParse = require('./utils').queryParse;
var dotProduct = require('./utils').dotProduct;
var arrProduct = require('./utils').arrProduct;
var magnitude = require('./utils').magnitude;
var arrToObj = require('./utils').arrToObj;
var arraySum = require('./utils').arraySum;

let URL_LIMIT = 300;
let QUERY_LIMIT = 50;
let TITLE_MATCH_WEIGHT = 1;

// Database Configuration

// Create our database, supply location and options.
// This will create or open the underlying LevelDB store.
var mydb_url_mapping = levelup('./mydb/url_mapping');
var mydb_word_mapping = levelup('./mydb/word_mapping');
var mydb_forward = levelup('./mydb/forward');
var mydb_inverted = levelup('./mydb/inverted');
var mydb_info = levelup('./mydb/info');
var mydb_parent_child = levelup('./mydb/parent_child');
console.log('Databases created at /mydb.');

var dbInterface_url_mapping = DbInterface({db: mydb_url_mapping});
var dbInterface_word_mapping = DbInterface({db: mydb_word_mapping});
var dbInterface_forward = DbInterface({db: mydb_forward});
var dbInterface_inverted = DbInterface({db: mydb_inverted});
var dbInterface_info = DbInterface({db: mydb_info});
var dbInterface_parent_child = DbInterface({db: mydb_parent_child});

app.use(bodyParser());
app.use('/static', express.static(__dirname + '/public'));

app.get('/', function(req, res){
	res.sendFile(path.join(__dirname + '/public/app/index.html'));
});

app.get('/admin', function(req, res){
	res.sendFile(path.join(__dirname + '/public/app/index.html'));
});

app.get('/spider', function(req, res){
	function generateSpiderEntry(inputs) {
		var title = inputs.meta.title;
		var url = inputs.url;
		var date = inputs.meta.date;
		var size = inputs.meta.size;
		var keywordsFreq = inputs.keywordsFreq;
		var childLinks = inputs.childLinks;

		function parseFreq(input) {
			if(input==null) return null;
			var string = '';
			Object.keys(input).forEach(function(key){
				string = string+key+' '+input[key]+'; ';
			});
			return string;
		}

		var result = [title,url,date+', '+size,parseFreq(keywordsFreq)];
		result = result.concat(childLinks,'--------------------------------------------------',null);

		return result.join('\n');
	}

	var arrOptions = {
		transformValFunc: stringToArr,
		excludeKey: []
	};
	var invertedOptions = {
		transformValFunc: invertedToArr,
		excludeKey: []
	};

	Promise.all([
		dbInterface_url_mapping.getAll(arrOptions),
		dbInterface_info.getAll(arrOptions),
		dbInterface_forward.getAll(arrOptions),
		dbInterface_inverted.getAll(invertedOptions),
		dbInterface_parent_child.getAll(arrOptions)

	]).then((result) => {
		var urls = Object.keys(result[0]);
		var info = result[1];
		var forward = result[2];
		var inverted = result[3];
		var children = result[4];
		var spider_contents = "";
		var spider_buffer = [];

		function forwardToFreq(words, docId){
			if(words[0]===''){
				return null;
			}
			var freqObj = {};
			words.forEach((word) => {
				var freqArr = arrToObj(inverted[word]);
				freqObj[word] = freqArr[docId].length;
			});
			return freqObj;
		}

		urls.forEach(function(url){
			var url_key = result[0][url];
			spider_contents = spider_contents + generateSpiderEntry({
				meta: {
					title: info[url_key][0],
					date: info[url_key][1],
					size: info[url_key][2]
				},
				url: url,
				keywordsFreq: forwardToFreq(forward[url_key], url_key),
				childLinks: children[url_key]
			});
			spider_buffer.push({
				meta: {
					title: info[url_key][0],
					date: info[url_key][1],
					size: info[url_key][2]
				},
				url: url,
				keywordsFreq: forwardToFreq(forward[url_key], url_key),
				childLinks: children[url_key],
				key: parseInt(url_key[0])
			});
		});
		res.send(spider_buffer);
		// res.set({"Content-Disposition":"attachment; filename=\"spider_result.txt\""});
		// res.send(spider_contents);
	});
});

app.get('/scrape', function(req, res){
	// function collectInternalLinks(response) {
	// 	var allRelativeLinks = [];
	// 	var allAbsoluteLinks = [];
	//
	// 	var relativeLinks = response.$("a[href^='/']");
	// 	relativeLinks.each(function() {
	// 	allRelativeLinks.push(response.$(this).attr('href'));
	//
	// 	});
	//
	// 	var absoluteLinks = response.$("a[href^='http']");
	// 	absoluteLinks.each(function() {
	// 		var link = response.$(this).attr('href');
	// 		// Remove trailing slash
	// 		link = link.replace(/\/$/, "");
	// 		// Remove ?XXX segments
	// 		link = link.replace(/\?(.*?)$/, "");
	// 		allAbsoluteLinks.push(link);
	// 	});
	//
	// 	// Unique links
	// 	allAbsoluteLinks = Array.from(new Set(allAbsoluteLinks));
	//
	// 	return [allRelativeLinks, allAbsoluteLinks];
	// }
	function collectLinks(response) {
		var links = response.$("a");
		var allLinks = [];

		links.each(function() {
			var link = "https://course.cse.ust.hk/comp4321/labs/TestPages/" + response.$(this).attr('href');
			allLinks.push(link)
		});
		return allLinks;
	}

	function buildPromiseChain(idx, promiseChain) {
		if(promiseChain.length == URL_LIMIT){
			return promiseChain;
		}

		if(promiseChain.length < URL_LIMIT){
			var options = {
			    uri: promiseChain[idx],
			    transform: function (body, response) {
		        	return {$: cheerio.load(body), headers: response.headers};
		    	}
			};

			return rp(options).then((response) => {
				var links = collectLinks(response);

				links.forEach(function(link){
					if(promiseChain.length < URL_LIMIT && promiseChain.indexOf(link)==-1){
						promiseChain.push(link);
					}
				});
				return buildPromiseChain(idx+1, promiseChain);
			}).catch(() => {
				promiseChain.splice(idx, 1);
				return buildPromiseChain(idx+1, promiseChain);
			});
		}
	}

	function makeRequest(url, url_id) {
		var options = {
		    uri: url,
		    simple: false,
		    transform: function (body, response) {
		        return {$: cheerio.load(body), headers: response.headers};
		    }
		};

	    return new Promise((resolve, reject) => {
	    	rp(options)
	    	.then(function(response){
	            function collectMeta(response) {
	            	var title = response.$('title').text().trim();
	            	if(!title) {
	            		title = url;
	            	}
	            	// Only for www.cse.ust.hk
	            	var date = response.$('p.right').text().match(/[0-9\-]+/g);
	            	if(date && Array.isArray(date)){
	            		date = date[0];
	            	}
	            	if(!date){
	            		date = response.headers['last-modified'] || response.headers.date;
	            	}
	            	date = date.replace(',', ' ');
	            	var size = response.headers['content-length'] || response.$('html > body').text().trim().length;
	            	return {title: title, date: date, size: size};
	            }

	            function collectWords(response) {
	            	// Remove javascript
	            	response.$('script').remove();
	            	// Remove styles
	            	response.$('style').remove();
	            	var bodyText = response.$('html > body').text();
	            	bodyText = bodyText.match(/[A-Za-z0-9]{2,20}/g);

	            	// Force all to lowercase
	            	var result = [];
	            	if(bodyText){
	            		result = bodyText.join('|').toLowerCase().split('|');
	            		bodyText = result;
	            	}
	            	return bodyText;
	            }

				var words = collectWords(response);

				if(words === null){
					words = [];
				}

				var posTable = wordsToPosTable(words);

				dbInterface_url_mapping.replace(url, url_id).then(function(){
					var links = collectLinks(response);
					dbInterface_parent_child.replace(url_id, links).then(function(){
						// Add page info
						// Url ID -> Info
						var raw_meta = collectMeta(response);
						dbInterface_info.replace(url_id, [raw_meta.title, raw_meta.date, raw_meta.size, words.length]).then(function(){
							// Add forward index
							// Url ID -> Keywords
							var keywords = Object.keys(posTable);
							dbInterface_forward.replace(url_id, keywords).then(function(){
								// Add word mapping
								// Word -> Word ID
								dbInterface_word_mapping.getAll({
									transformValFunc: null,
									excludeKey: []
								}).then(function(winstance){
									var word_mapping_promises = [];
									var inverted_promises = [];
									// Get the most recent added Word ID
									var wsize = Object.keys(winstance).length;
									if(wsize>0){
										wsize--;
									}
									Object.keys(posTable).forEach(function(word, widx){
										word_mapping_promises.push(dbInterface_word_mapping.update(word, wsize+widx, false));
										inverted_promises.push(dbInterface_inverted.update(word, [url_id, posTable[word].length].concat(posTable[word])));
									});
									Promise.all(word_mapping_promises.concat(inverted_promises)).then(function(){
										resolve(1);
									});
								});
							});
						});
					});

				});
			});
		});
	}

	var final = 0;
	var idx = 0;
	function workPromiseChain(chain) {
    	return chain.reduce((promise, url) => {
    		return promise
	    		.then((result) => {
	    			return makeRequest(url,idx).then((result) => {
	    				idx++;
	    				final+=result;
	    				console.log('('+Math.round(final/URL_LIMIT*100)+'%) Processed '+url);
	    			});
	    		});
    	}, Promise.resolve());
	}

	res.send('Check console for progress/result.');

	// The URL we will scrape from
    var ROOT = 'https://course.cse.ust.hk/comp4321/labs/TestPages/testpage.htm';
    console.log('Scrape started...');
    buildPromiseChain(0, [ROOT]).then((result)=>{
    	console.log(result.length+' links found.');
    	workPromiseChain(result)
    	.then(() => {
			console.log('Scrape completed. '+result.length+' links scraped.');
		});
    });
});

app.post('/query', (req, res) => {
	// Step 1: Convert query to tf*idf scores
	var sample_query = req.body.query;
	var stemmed_query = wordsToStemmed(queryParse(sample_query)[0]);

	function getQueryTf(query, word){
		var counts = {};
		for(var i = 0; i < query.length; i++) {
		    var num = query[i];
		    counts[num] = counts[num] ? counts[num]+1 : 1;
		}
		var sum = query.length;
		if(req.body.phrase_query!=null){
			sum+=1;
		}
		return counts[word]/sum;
	}

	function getIdfPromise(word){
		return dbInterface_inverted.get(word).then(function(val){
			if(val===false){
				return {word: word, data: 1};
			}
			var docs = invertedToArr(val);
			return {word: word, data: 1 + Math.log(URL_LIMIT/docs.length)};
		});
	}

	function getQueryToTfidf(){
		return Promise.all(stemmed_query.map(function(word){
			return getIdfPromise(word);
		})).then(function(idfResult){
			return idfResult.map(function(idf){
				return idf.data*getQueryTf(stemmed_query,idf.word);
			});
		});
	}

	// Step 2: Convert documents to tf*idf scores
	function getTfPromise(word, docId){
		return Promise.all([dbInterface_inverted.get(word), dbInterface_info.get(docId)]).then(function(result){
			var inverted = result[0];
			var info = result[1];

			var notFound = {word: word, data: 0};
			if(inverted === false){
				return notFound;
			}

			var docs = invertedToArr(inverted);
			// Convert arr to object, keys are unique
			docs = arrToObj(docs);
			var docLength = parseInt(stringToArr(info)[3]);
			var occurence = 0;

			if(docs.hasOwnProperty(docId)){
				occurence = docs[docId].length;
			}
			if(docLength>0){
				occurence/=docLength;
			}

			return {word: word, data: occurence};
		});
	}

	// docId used
	function getDocsToTf(){
		return dbInterface_forward.getAll({
			transformValFunc: stringToArr,
			excludeKey: []
		}).then(function(urls){
			return Promise.all(Object.keys(urls).map(function(docId){
				return Promise.all(stemmed_query.map(function(word){
					return getTfPromise(word, docId);
				})).then(function(tfs){
					return tfs.map(function(tf){
						return tf.data;
					});
				});
			}));
		});
	}

	// docId not used
	function getDocsToIdf(){
		return dbInterface_forward.getAll({
			transformValFunc: stringToArr,
			excludeKey: []
		}).then(function(urls){
			return Promise.all(Object.keys(urls).map(function(docId){
				return Promise.all(stemmed_query.map(function(word){
					return getIdfPromise(word);
				})).then(function(idfs){
					return idfs.map(function(idf){
						return idf.data;
					});
				});
			}));
		});
	}

	function getDocsToTfidf(){
		return Promise.all([getDocsToTf(), getDocsToIdf()]).then(function(result){
			var tfidfs = result[0].map(function(tfs, idx){
				return arrProduct(tfs, result[1][idx]);
			});
			return tfidfs;
		});
	}

	// Step 3: Calculate Cosine similarity
	function cosineSimilarity(query, doc){
		return dotProduct(query, doc)/magnitude(query)*magnitude(doc);
	}

	// Comparison function to sort scores
	function compare(a,b) {
		if (a.score < b.score)
			return 1;
		if (a.score > b.score)
			return -1;
		return 0;
	}

	// Get all pages and info
	var arrOptions = {
		transformValFunc: stringToArr,
		excludeKey: []
	};
	var invertedOptions = {
		transformValFunc: invertedToArr,
		excludeKey: []
	};

	// The object containing functions to process phrased queries
	var processPhrase = {
		init: function(){
			if(req.body.phrase_query.length==0){
				return [[],[]];
			}
			stemmed_phrase_query = wordsToStemmed(queryParse(req.body.phrase_query)[0]);
			return [this.getPhraseQueryToTfidf(stemmed_phrase_query), this.getPhraseDocsToTfidf(stemmed_phrase_query)];
		},
		getPhraseQueryIdf: function(phrase_query_split){
			return 1 + Math.log(1/(req.body.query.split(' ').length+1));
		},
		getPhraseTf: function(phrase){
			function findDiffOne(a,b){
				function extractValue(object){
					return object[Object.keys(object)[0]];
				}

				a = extractValue(a);
				b = extractValue(b);

			  var num = 0;
			  a.forEach(function(aitem){
			    b.forEach(function(bitem){
			      if(Math.abs(aitem-bitem)==1){
			        num++;
			      }
			    });
			  });
			  return num;
			}

			return Promise.all([dbInterface_url_mapping.getAll(arrOptions), dbInterface_inverted.getAll(invertedOptions)]).then((result) => {
				var mappings = result[0];
				var pos_info = result[1];
				return Object.keys(mappings).map(function(url_string){
					var url_key = mappings[url_string];
					return phrase.reduce(function(a, b){
						// Need to satisfy one condition
						// 1. Both exist on same page
						// return number of pairs of abs(pos_0, pos_1)
						if(pos_info[a][url_key]==undefined || pos_info[b][url_key]==undefined){
							return {data: 0, docId: url_key};
						}
						return {data: findDiffOne(pos_info[a][url_key],pos_info[b][url_key]), docId: url_key};
					});
				});
			});
		},
		getPhraseQueryToTfidf: function(phrase){
				return [1*this.getPhraseQueryIdf(phrase)];
		},
		getPhraseDocsToTfidf: function(phrase){
			return Promise.all([this.getPhraseTf(phrase), dbInterface_info.getAll(arrOptions)]).then((result)=>{
				var tfResult = result[0];
				var getPageLength = function(id){
					return result[1][id][3];
				};
				var tfresNonZeroNum = tfResult.filter(function(tf){
				  return tf.data>0;
				}).length;

				return tfResult.map(function(tf){
					var TF = tf.data/(getPageLength(tf.docId)-Math.pow(Math.max(1,tf.data),stemmed_phrase_query.length-1));
					var IDF = 1+Math.log(tfResult.length/tfresNonZeroNum);
					return TF * IDF;
				});
			});
		}
	};

	Promise.all([
		dbInterface_url_mapping.getAll(arrOptions),
		dbInterface_info.getAll(arrOptions),
		dbInterface_forward.getAll(arrOptions),
		dbInterface_inverted.getAll(invertedOptions),
		dbInterface_parent_child.getAll(arrOptions),
		getQueryToTfidf(),
		getDocsToTfidf()
	].concat(processPhrase.init())).then((result) => {
		var getUrl = function(val) {
			return Object.keys(result[0]).filter(function(url){
				return result[0][url] == val;
			})[0];
		};

		var info = result[1];
		var forward = result[2];
		var inverted = result[3];
		var children = result[4];
		var scoreResult = [result[5],result[6]]

		// Case where term is not found in all documents
		if(scoreResult[0].length==0){
			res.json([]);
		}

		function forwardToFreq(words, docId){
			if(words[0]===''){
				return null;
			}
			var freqObj = {};
			words.forEach((word) => {
				var freqArr = arrToObj(inverted[word]);
				freqObj[word] = freqArr[docId].length;
			});
			return freqObj;
		}

		// To set the titleMatchBonus, a weight is set for the final bonus
		function titleMatchBonus(query, title){
			return TITLE_MATCH_WEIGHT*query.reduce(function(a, b){
				var _a = title.indexOf(a)!=-1 ? 1 : 0;
				var _b = title.indexOf(b)!=-1 ? 1 : 0;
				return _a + _b;
			}, TITLE_MATCH_WEIGHT);
		}

		// TWO cases to calculate the score

		// Case 1: normal query
		// idx is the url key
		// add the title match bonus
		var rawScore = scoreResult[1].map(function(doc, idx){
			var titleMatchBonus_score = titleMatchBonus(stemmed_query, wordsToStemmed(info[idx][0].toLowerCase().split(' ')));
			var result = {key: idx, score: cosineSimilarity(scoreResult[0],doc) + titleMatchBonus_score};
			return result;
		});

		// Case 2: phrase query
		if(result[7].length>0 && result[8].length>0){
			var phraseScore = result[8].map(function(doc, idx){
					var titleMatchPhraseBonus_score = titleMatchBonus([wordsToStemmed(queryParse(req.body.phrase_query)[0]).join(' ')], wordsToStemmed(info[idx][0].toLowerCase().split(' ')).join(' '));
					var phrase_result = {key: idx, score: cosineSimilarity(result[7], [doc])};
					return phrase_result;
			});
			// Add the phrase score to the rawScore
			rawScore = rawScore.map(function(raw, idx){
				raw.score = raw.score + phraseScore[idx].score;
				return raw;
			});
		}

		// Remove zero scores
		rawScore = rawScore.filter(function(item, idx){
			return item.score > 0;
		});

		// Sort in descending order
		rawScore.sort(compare);
		if(rawScore.length>QUERY_LIMIT){
			rawScore = rawScore.splice(0,QUERY_LIMIT);
		}

		var query_result = rawScore.map(function(qres){
			var url_key = qres.key;
			return {
				meta: {
					title: info[url_key][0],
					date: info[url_key][1],
					size: info[url_key][2]
				},
				url: getUrl(url_key),
				keywordsFreq: forwardToFreq(forward[url_key], url_key),
				childLinks: children[url_key],
				score: qres.score
			};
		});
		res.json(query_result);
	});
});

app.get('/db_url_mapping', (req, res) => {
	dbInterface_url_mapping.getAll({
		transformValFunc: null,
		excludeKey: []
	}).then(function(instance){
		res.json(instance);
	});
});

app.get('/db_word_mapping', function(req, res){
	dbInterface_word_mapping.getAll({
		transformValFunc: null,
		excludeKey: []
	}).then(function(instance){
		res.json(instance);
	});
});

app.get('/db_forward', function(req, res){
	dbInterface_forward.getAll({
		transformValFunc: stringToArr,
		excludeKey: []
	}).then(function(instance){
		res.json(instance);
	});
});

app.get('/db_inverted', function(req, res){
	dbInterface_inverted.getAll({
		transformValFunc: invertedToArr,
		excludeKey: []
	}).then(function(instance){
		res.json(instance);
	});
});

app.get('/db_info', function(req, res){
	dbInterface_info.getAll({
		transformValFunc: stringToArr,
		excludeKey: []
	}).then(function(instance){
		res.json(instance);
	});
});

app.get('/db_parent_child', function(req, res){
	dbInterface_parent_child.getAll({
		transformValFunc: stringToArr,
		excludeKey: []
	}).then(function(instance){
		res.json(instance);
	});
});

app.use(function(req, res){
	res.sendStatus(404);
});

app.listen('8081');

console.log("   ___                      _      \n  |_  |                    (_)     \n    | |  __ _  _ __ __   __ _  ___ \n    | | / _` || '__|\ \ / /| |/ __|\n /\__/ /| (_| || |    \ V / | |\__ \\\n  \____/  \__,_||_|     \_/  |_||___/\n                                   \n");
console.log('Jarvis standing-by on port 8081.');

exports = module.exports = app;
