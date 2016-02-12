EPUBJS.Renderer = function(renderMethod, hidden) {
	// Dom events to listen for
	this.listenedEvents = ["keydown", "keyup", "keypressed", "mouseup", "mousedown", "click"];
	this.upEvent = "mouseup";
	this.downEvent = "mousedown";
	if('ontouchstart' in document.documentElement) {
		this.listenedEvents.push("touchstart", "touchend");
		this.upEvent = "touchend";
		this.downEvent = "touchstart";
	}

	/**
	* Setup a render method.
	* Options are: Iframe
	*/
	if(renderMethod && typeof(EPUBJS.Render[renderMethod]) != "undefined"){
		// Create a pool of renders so it's possible for us to load the
		// previous, current and next sets of chapters.
		this.renders = [];
		this.renderMethod = renderMethod;
		this.firstVisibleRender = 0;
	} else {
		console.error("Not a Valid Rendering Method");
	}

	// Cached for replacement urls from storage
	this.caches = {};

	// Blank Cfi for Parsing
	this.epubcfi = new EPUBJS.EpubCFI();

	this.spreads = true;
	this.isForcedSingle = false;
	this.resized = this.onResized.bind(this);

	this.layoutSettings = {};

	this.hidden = hidden || false;
	//-- Adds Hook methods to the Book prototype
	//   Hooks will all return before triggering the callback.
	EPUBJS.Hooks.mixin(this);
	//-- Get pre-registered hooks for events
	this.getHooks("beforeChapterDisplay");

	//-- Queue up page changes if page map isn't ready
	this._q = EPUBJS.core.queue(this);

	this._moving = false;

};

//-- Renderer events for listening
EPUBJS.Renderer.prototype.Events = [
	"renderer:keydown",
	"renderer:keyup",
	"renderer:keypressed",
	"renderer:mouseup",
	"renderer:mousedown",
	"renderer:click",
	"renderer:touchstart",
	"renderer:touchend",
	"renderer:selected",
	"renderer:chapterUnload",
	"renderer:chapterUnloaded",
	"renderer:chapterDisplayed",
	"renderer:locationChanged",
	"renderer:visibleLocationChanged",
	"renderer:visibleRangeChanged",
	"renderer:resized",
	"renderer:spreads"
];

/**
* Creates an element to render to.
* Resizes to passed width and height or to the elements size
*/
EPUBJS.Renderer.prototype.initialize = function(element, width, height){
	this.container = element;

	this.initWidth = width;
	this.initHeight = height;

	this.width = width || this.container.clientWidth;
	this.height = height || this.container.clientHeight;

	document.addEventListener("orientationchange", this.onResized.bind(this));
};

EPUBJS.Renderer.prototype.findRenderForChapter = function(chapter){
	return EPUBJS.core.find(this.renders, function (render) {
		return render.chapter && render.chapter.id === chapter.id;
	}, this);
};

EPUBJS.Renderer.prototype.createRender = function () {
	var render = new EPUBJS.Render[this.renderMethod]();
	render.on("render:loaded", this.loaded.bind(this));
	render.create();
	return render;
};

/**
* Display a chapter
* Takes: chapter object, global layout settings
* Returns: Promise with passed Renderer after pages has loaded
*/
EPUBJS.Renderer.prototype.displayChapters = function(chapters, globalLayout){
	if(this._moving) {
		console.warning("Rendering In Progress");
        var deferred = new RSVP.defer();
        deferred.reject({
            message : "Rendering In Progress",
            stack : new Error().stack
        });
		return deferred.promise;
	}
	this._moving = true;

	// Sort the chapters by their spine positions before assigning them to
	// renders, so the renders are in the right order in the DOM. We copy the
	// array, because the orginal chapter ordering was prioritized by the
	// most-important-to-load first.
	var sortedChapters = chapters.slice();
	sortedChapters.sort(function(a, b) {
		return a.spinePos - b.spinePos;
	}, this);

	if (this.direction === "rtl") {
		sortedChapters.reverse();
	}

	// Determine the renders that already have loaded requested chapters,
	// thereby captializing on chapter pre-loading, and await the rest to load
	// into new renders.
	var existingRenders = [];
	var unusedRenders = this.renders.slice();
	var newRenders = [];
	var awaitedChapters = chapters.slice();
	sortedChapters.forEach(function(chapter) {
		var render = this.findRenderForChapter(chapter);
		if (render) {
			existingRenders.push(render);
			EPUBJS.core.remove(unusedRenders, render);
			EPUBJS.core.remove(awaitedChapters, chapter);
		} else {
			render = this.createRender();
			render.chapter = chapter;
			newRenders.push(render);
		}
	}, this);

	// Clean up old renders. We can't reuse them because iframes can't be
	// rearranged in the DOM without destroying their contents.
	unusedRenders.forEach(function (render) {
		render.unload();
		render.element.parentElement.removeChild(render.element);
		EPUBJS.core.remove(this.renders, render);
	}, this);

	newRenders.forEach(function (newRender) {
		var inserted = existingRenders.some(function (existingRender) {
			var compare = this.direction === "rtl" ?
				function (a, b) { return a > b; } :
				function (a, b) { return a < b; };
			if (compare(newRender.chapter.spinePos, existingRender.chapter.spinePos)) {
				// The renders are always sorted, it is safe to assume this
				// render should also come before the others.
				this.container.insertBefore(newRender.element, existingRender.element);
				this.renders.unshift(newRender);
				return true;
			}
		}, this);
		if (!inserted) {
			this.container.appendChild(newRender.element);
			this.renders.push(newRender);
		}
	}, this);

	// Reset the other render positions, since they are recycled and if we
	// navigated away from them they'd maintain their positions and mess up the
	// mapPage calculations.
	existingRenders.forEach(function (render) {
		render.page(1);
	}, this);

	// Try to recycle an existing chapter object because it might have a
	// document object associated with it, which might be needed later when
	// mapping a page. (Chapter objects are created ad-hoc.)
	var possibleCurrentChapters = chapters.slice(0, 2);
	this.currentChapters = possibleCurrentChapters.map(function (chapter) {
		var render = this.findRenderForChapter(chapter);
		if (render && render.chapter.id === chapter.id) {
			return render.chapter;
		}
		return chapter;
	}, this).filter(function (chapter, index, chapters) {
		// If the first chapter is the first current chapter, because it might
		// the cover of the book, it should be the only current chapter.
		if (chapters[0].spinePos === 0) {
			return index === 0;
		}
		// A chapter coming before an earlier chapter cannot possibly come after
		// that chapter (which could happen if on the last chapter), so filter
		// those out.
		var chaptersBefore = chapters.slice(0, index);
		return !chaptersBefore.some(function (chapterBefore) {
			return chapterBefore.spinePos > chapter.spinePos;
		});
	}, this);

	this.firstVisibleRender =
		EPUBJS.core.findIndex(this.renders, function (render) {
			return render.chapter.id === this.currentChapters[0].id;
		}, this);

	// FIXME: Locking and toggling visibility negates some advantages of
	// pre-loading... see if it's possible to un-lock this method, somehow.
	this.visible(false);

	var chapterRenderPromises = awaitedChapters.map(function(chapter) {
		var render = this.findRenderForChapter(chapter);
		return chapter.render().then(function(contents) {

			// Unload the previous chapter listener
			if(render.previousChapter && render.previousChapter.id !== chapter.id) {
				this.trigger("renderer:chapterUnload");
				render.previousChapter.unload(); // Remove stored blobs

				if(render.window){
					render.window.removeEventListener("resize", this.resized);
				}

				this.removeEventListeners(render);
				this.removeSelectionListeners(render);
				this.trigger("renderer:chapterUnloaded");
				this.contents = null;
				this.doc = null;
				this.pageMap = null;
			}

			this.chapterPos = 1;

			this.layoutSettings = this.reconcileLayoutSettings(globalLayout, chapter.properties);

			return this.load(contents, chapter.href, render);

		}.bind(this));
	}, this);

	return RSVP.all(chapterRenderPromises).then(function () {
		// Guarantee that render visibility updates (in the case of no new
		// chapters needing to be loaded).
		if (chapterRenderPromises.length === 0) {
			this.updateRenderVisibility();
		}
		this._moving = false;
		this.visible(true);
	}.bind(this));
};

/**
* Loads a url (string) and renders it,
* attaching event listeners and triggering hooks.
* Returns: Promise with the rendered contents.
*/

EPUBJS.Renderer.prototype.load = function(contents, url, render){
	var deferred = new RSVP.defer();
	var loaded;

	// Switch to the required layout method for the settings
	this.determineLayout();

	render.load(contents, url).then(function(contents) {

		// Duck-type fixed layout books.
		if (EPUBJS.Layout.isFixedLayout(contents)) {
			this.layoutSettings.layout = "pre-paginated";
			this.determineLayout();
		}
		render.setLayout(this.layoutSettings.layout);

		// HTML element must have direction set if RTL or columnns will
		// not be in the correct direction in Firefox
		// Firefox also need the html element to be position right
		if(render.direction == "rtl" && render.docEl.dir != "rtl"){
			render.docEl.dir = "rtl";
			if (render.layout !== "pre-paginated") {
				render.docEl.style.position = "absolute";
				render.docEl.style.right = "0";
			}
		}

		this.afterLoad(contents, render);

		//-- Trigger registered hooks before displaying
		this.beforeDisplay(function(){

			this.afterDisplay(render.chapter);

			deferred.resolve(this); //-- why does this return the renderer?

		}.bind(this));

	}.bind(this));

	return deferred.promise;
};

EPUBJS.Renderer.prototype.afterLoad = function(contents, render) {
	render.chapter.setDocument(render.document);

	// TODO: Remove these variables, maybe with back-compat getters, but
	// they don't seem to be necessary.
	this.contents = contents;
	this.doc = render.document;

	// Format the contents using the current layout method
	var formatted = this.layout.format(contents, render.width, render.height, this.gap);
	render.setPageDimensions(formatted.pageWidth, formatted.pageHeight, formatted.scale);
	this.updateRenderVisibility();

	// window.addEventListener("orientationchange", this.onResized.bind(this), false);
	if(!this.initWidth && !this.initHeight){
		render.window.addEventListener("resize", this.resized, false);
	}

	this.addEventListeners(render);
	this.addSelectionListeners(render);

};

EPUBJS.Renderer.prototype.afterDisplay = function(chapter) {

	var msg = chapter;
	var queued = this._q.length();
	this._moving = false;

	this.updatePages();

	this.visibleRangeCfi = this.getVisibleRangeCfi();
	this.currentLocationCfi = this.visibleRangeCfi.start;

	if(queued === 0) {
		this.trigger("renderer:locationChanged", this.currentLocationCfi);
		this.trigger("renderer:visibleRangeChanged", this.visibleRangeCfi);
	}

	msg.cfi = this.currentLocationCfi; //TODO: why is this cfi passed to chapterDisplayed
	this.trigger("renderer:chapterDisplayed", msg);

};

EPUBJS.Renderer.prototype.loaded = function(url){
	this.trigger("render:loaded", url);
	// var uri = EPUBJS.core.uri(url);
	// var relative = uri.path.replace(book.bookUrl, '');
	// console.log(url, uri, relative);
};

EPUBJS.Renderer.prototype.getCurrentChapter = function () {
	if (this.currentChapters) {
		return this.currentChapters[0];
	}
};

// TODO: Remove this method, it's just an intermediate helper method for
// transitioning to a "multiple render mentality."
EPUBJS.Renderer.prototype.getVisibleRender = function() {
    return this.renders[this.firstVisibleRender];
};

EPUBJS.Renderer.prototype.getMaximumVisibleChapters = function () {
    var count;
	if (this.layoutSettings.layout === "pre-paginated" && this.spreads) {
		count = 2;
	} else {
		count = 1;
	}
	return count;
};

EPUBJS.Renderer.prototype.getVisibleChapters = function () {
    var count = this.getMaximumVisibleChapters();
	var start;
	if (this.direction === "rtl") {
		start = this.currentChapters.length - count;
	} else {
		start = 0;
	}
	return this.currentChapters.slice(start, start + count);
};

EPUBJS.Renderer.prototype.getVisibleRenders = function() {
	var visibleChapters = this.getVisibleChapters();
	return visibleChapters.map(function(chapter) {
		return this.findRenderForChapter(chapter);
	}, this);
};

EPUBJS.Renderer.prototype.resizeRender = function (render) {
	var visibleRenders = this.getVisibleRenders();
	// Allocate space for each render.
	var width;
	if (this.layoutSettings.layout === "pre-paginated") {
		// TODO: This looks very similar to the code in Layout.Fixed... see if
		// we can consolidate it.
		var widthScale = this.width / visibleRenders.length / render.pageWidth;
		var heightScale = (this.height / render.pageHeight);
		var scale = widthScale < heightScale ? widthScale : heightScale;
		width = Math.floor(render.pageWidth * scale) * 0.95;
	} else {
		width = (1 / visibleRenders.length * 100) + "%";
	}
	var height = "100%";
	render.resize(width, height);
};

EPUBJS.Renderer.prototype.updateRenderVisibility = function() {
    var visibleRenders = this.getVisibleRenders();
	this.renders.forEach(function (render) {
		var isVisible = EPUBJS.core.contains(visibleRenders, render);
		render.visible(isVisible);
		this.resizeRender(render);
	}, this);
};

/**
* Reconciles the current chapters layout properies with
* the global layout properities.
* Takes: global layout settings object, chapter properties string
* Returns: Object with layout properties
*/
EPUBJS.Renderer.prototype.reconcileLayoutSettings = function(global, chapter){
	var settings = {};

	//-- Get the global defaults
	for (var attr in global) {
		if (global.hasOwnProperty(attr)){
			settings[attr] = global[attr];
		}
	}
	//-- Get the chapter's display type
	chapter.forEach(function(prop){
		var rendition = prop.replace("rendition:", '');
		var split = rendition.indexOf("-");
		var property, value;

		if(split != -1){
			property = rendition.slice(0, split);
			value = rendition.slice(split+1);

			settings[property] = value;
		}
	});
 return settings;
};

/**
* Uses the settings to determine which Layout Method is needed
* Triggers events based on the method choosen
* Takes: Layout settings object
* Returns: String of appropriate for EPUBJS.Layout function
*/
EPUBJS.Renderer.prototype.determineLayout = function(){
	var settings = this.layoutSettings;

	// Default is layout: reflowable & spread: auto
	var spreads = this.determineSpreads(this.minSpreadWidth);
	var layoutMethod = spreads ? "ReflowableSpreads" : "Reflowable";
	var scroll = false;

	if(settings.layout === "pre-paginated") {
		layoutMethod = "Fixed";
		scroll = true;
		// Use the determined spreads value.
	}

	if(settings.layout === "reflowable" && settings.spread === "none") {
		layoutMethod = "Reflowable";
		scroll = false;
		spreads = false;
	}

	if(settings.layout === "reflowable" && settings.spread === "both") {
		layoutMethod = "ReflowableSpreads";
		scroll = false;
		spreads = true;
	}

	this.spreads = spreads;
	this.renders.forEach(function(render) {
		render.scroll(scroll);
	}, this);
	this.trigger("renderer:spreads", spreads);

	this.layout = new EPUBJS.Layout[layoutMethod]();
};

// Shortcut to trigger the hook before displaying the chapter
EPUBJS.Renderer.prototype.beforeDisplay = function(callback, renderer){
	this.triggerHooks("beforeChapterDisplay", callback, this);
};

EPUBJS.Renderer.prototype.updatePages = function(){
	// TODO: Needs to handle the pages of multiple chapters

	this.pageMap = this.mapPage();

	if (this.spreads) {
		this.displayedPages = Math.ceil(this.pageMap.length / 2);
	} else {
		this.displayedPages = this.pageMap.length;
	}

	this.getCurrentChapter().pages = this.pageMap.length;

	this._q.flush();
};

// Apply the layout again and jump back to the previous cfi position
EPUBJS.Renderer.prototype.reformat = function(){
	var renderer = this;
	var spreads;

	if(!this.contents) return;

	spreads = this.determineSpreads(this.minSpreadWidth);

	// Only re-layout if the spreads have switched
	if(spreads != this.spreads){
		this.spreads = spreads;
		this.determineLayout();
		this.updateRenderVisibility();
	} else {
		// updateRenderVisibility normally calls this, make sure we still do
		// even if there are spreads.
		this.renders.forEach(function (render) {
			this.resizeRender(render);
		}, this);
	}

	// Reset pages
	this.chapterPos = 1;

	this.renders.forEach(function(render) {
		render.page(this.chapterPos);
		var formatted = renderer.layout.format(render.docEl, render.width, render.height, renderer.gap);
		render.setPageDimensions(formatted.pageWidth, formatted.pageHeight, formatted.scale);
	}, this);

	renderer.updatePages();

	//-- Go to current page after formating
	if(renderer.currentLocationCfi){
		renderer.gotoCfi(renderer.currentLocationCfi);
	}
};

// Hide and show the render's container .
EPUBJS.Renderer.prototype.visible = function(bool){
	if(typeof(bool) === "undefined") {
		return this.container.style.visibility;
	}

	if(bool === true && !this.hidden){
		this.container.style.visibility = "visible";
	}else if(bool === false){
		this.container.style.visibility = "hidden";
	}
};

// Remove the render element and clean up listeners
EPUBJS.Renderer.prototype.remove = function() {
	this.renders.forEach(function(render) {
		if(render.window) {
			render.unload();
			render.window.removeEventListener("resize", this.resized);
			this.removeEventListeners(render);
			this.removeSelectionListeners(render);
		}
	}, this);

	this.renders.forEach(function(render) {
		this.container.removeChild(render.element);
	}, this);
};

//-- STYLES

EPUBJS.Renderer.prototype.applyStyles = function(styles) {
	for (var style in styles) {
		this.renders.forEach(function(render) {
			render.setStyle(style, styles[style]);
		}, this);
	}
};

EPUBJS.Renderer.prototype.setStyle = function(style, val, prefixed){
	this.renders.forEach(function(render) {
		render.setStyle(style, val, prefixed);
	}, this);
};

EPUBJS.Renderer.prototype.removeStyle = function(style){
	this.renders.forEach(function(render) {
		render.removeStyle(style);
	}, this);
};

//-- HEAD TAGS
EPUBJS.Renderer.prototype.applyHeadTags = function(headTags) {
	for ( var headTag in headTags ) {
		this.renders.forEach(function(render) {
			render.addHeadTag(headTag, headTags[headTag]);
		}, this);
	}
};

//-- NAVIGATION

EPUBJS.Renderer.prototype.page = function(pg){
	if(!this.pageMap) {
		console.warn("pageMap not set, queuing");
		this._q.enqueue("page", arguments);
		return true;
	}

	if(pg >= 1 && pg <= this.displayedPages){
		this.chapterPos = pg;

		// TODO: Needs to jump the relevant render to the correct page
		this.getVisibleRender().page(pg);
		this.visibleRangeCfi = this.getVisibleRangeCfi();
		this.currentLocationCfi = this.visibleRangeCfi.start;
		this.trigger("renderer:locationChanged", this.currentLocationCfi);
		this.trigger("renderer:visibleRangeChanged", this.visibleRangeCfi);

		return true;
	}
	//-- Return false if page is greater than the total
	return false;
};

// Short cut to find next page's cfi starting at the last visible element
/*
EPUBJS.Renderer.prototype.nextPage = function(){
	var pg = this.chapterPos + 1;
	if(pg <= this.displayedPages){
		this.chapterPos = pg;

		this.render.page(pg);

		this.currentLocationCfi = this.getPageCfi(this.visibileEl);
		this.trigger("renderer:locationChanged", this.currentLocationCfi);

		return true;
	}
	//-- Return false if page is greater than the total
	return false;
};
*/
EPUBJS.Renderer.prototype.nextPage = function(){
	return this.page(this.chapterPos + 1);
};

EPUBJS.Renderer.prototype.prevPage = function(){
	return this.page(this.chapterPos - 1);
};

//-- Show the page containing an Element
EPUBJS.Renderer.prototype.pageByElement = function(el){
	var pg;
	if(!el) return;

	// TODO: Needs to iterate each render
	pg = this.getVisibleRender().getPageNumberByElement(el);
	this.page(pg);
};

// Jump to the last page of the chapter
EPUBJS.Renderer.prototype.lastPage = function(){
	if(this._moving) {
		return this._q.enqueue("lastPage", arguments);
	}

	this.page(this.displayedPages);
};

// Jump to the first page of the chapter
EPUBJS.Renderer.prototype.firstPage = function(){
	if(this._moving) {
		return this._q.enqueue("firstPage", arguments);
	}

	this.page(1);
};

//-- Find a section by fragement id
EPUBJS.Renderer.prototype.section = function(fragment){
	var el = this.doc.getElementById(fragment);

	if(el){
		this.pageByElement(el);
	}

};

EPUBJS.Renderer.prototype.firstElementisTextNode = function(node) {
	var children = node.childNodes;
	var leng = children.length;

	if(leng &&
		children[0] && // First Child
		children[0].nodeType === 3 && // This is a textNodes
		children[0].textContent.trim().length) { // With non whitespace or return characters
		return true;
	}
	return false;
};

EPUBJS.Renderer.prototype.isGoodNode = function(node) {
	var embeddedElements = ["audio", "canvas", "embed", "iframe", "img", "math", "object", "svg", "video"];
	if (embeddedElements.indexOf(node.tagName.toLowerCase()) !== -1) {
		// Embedded elements usually do not have a text node as first element, but are also good nodes
		return true;
	}
	return this.firstElementisTextNode(node);
};

// Walk the node tree from a start element to next visible element
EPUBJS.Renderer.prototype.walk = function(node, x, y) {
	var r, children, leng,
		startNode = node,
		prevNode,
		stack = [startNode];

	var STOP = 10000, ITER=0;

	while(!r && stack.length) {
		node = stack.shift();
		if( this.containsPoint(node, x, y) && this.isGoodNode(node)) {
			r = node;
		}

		if(!r && node && node.childElementCount > 0){
			children = node.children;
			if (children && children.length) {
				leng = children.length ? children.length : 0;
			} else {
				return r;
			}
			for (var i = leng-1; i >= 0; i--) {
				if(children[i] != prevNode) stack.unshift(children[i]);
			}
		}

		if(!r && stack.length === 0 && startNode && startNode.parentNode !== null){
			stack.push(startNode.parentNode);
			prevNode = startNode;
			startNode = startNode.parentNode;
		}


		ITER++;
		if(ITER > STOP) {
			console.error("ENDLESS LOOP");
			break;
		}

	}

	return r;
};

// Checks if an element is on the screen
EPUBJS.Renderer.prototype.containsPoint = function(el, x, y){
	var rect;
	var left;
	if(el && typeof el.getBoundingClientRect === 'function'){
		rect = el.getBoundingClientRect();
		// console.log(el, rect, x, y);

		if( rect.width !== 0 &&
				rect.height !== 0 && // Element not visible
				rect.left >= x &&
				x <= rect.left + rect.width) {
			return true;
		}
	}

	return false;
};

EPUBJS.Renderer.prototype.textSprint = function(root, func) {
	var filterEmpty = function(node){
		if ( ! /^\s*$/.test(node.data) ) {
			return NodeFilter.FILTER_ACCEPT;
		} else {
			return NodeFilter.FILTER_REJECT;
		}
	};
	var treeWalker;
	var node;

	try {
		treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: filterEmpty
		}, false);
		node = treeWalker.nextNode(); // IE won't throw an error until calling this
	} catch (e) {
		// IE doesn't accept the object, just wants a function
		// https://msdn.microsoft.com/en-us/library/ff974820(v=vs.85).aspx
		treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, filterEmpty, false);
		node = treeWalker.nextNode();
	}

	while (node) {
		func(node);
		node = treeWalker.nextNode();
	}

};

EPUBJS.Renderer.prototype.sprint = function(root, func) {
	var treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
	var node;
	while ((node = treeWalker.nextNode())) {
		func(node);
	}

};

EPUBJS.Renderer.prototype.mapPage = function(){
	var renderer = this;
	var map = [];
	var root = this.getVisibleRender().getBaseElement();
	var page = 1;
	var width = this.layout.colWidth + this.layout.gap;
	var offset = this.getVisibleRender().pageWidth * (this.chapterPos-1);
	var limit = (width * page) - offset;// (width * page) - offset;
	var elLimit = 0;
	var prevRange;
	var prevRanges;
	var cfi;
	var lastChildren = null;
	var prevElement;
	var startRange, endRange;
	var startCfi, endCfi;
	var check = function(node) {
		var elPos;
		var elRange;
		var found;
		if (node.nodeType == Node.TEXT_NODE) {

			elRange = document.createRange();
			elRange.selectNodeContents(node);
			elPos = elRange.getBoundingClientRect();

			if(!elPos || (elPos.width === 0 && elPos.height === 0)) {
				return;
			}

			//-- Element starts new Col
			if(elPos.left > elLimit) {
				found = checkText(node);
			}

			//-- Element Spans new Col
			if(elPos.right > elLimit) {
				found = checkText(node);
			}

			prevElement = node;

			if (found) {
				prevRange = null;
			}
		}

	};
	var checkText = function(node){
		var result;
		var ranges = renderer.splitTextNodeIntoWordsRanges(node);

		ranges.forEach(function(range){
			var pos = range.getBoundingClientRect();

			if(!pos || (pos.width === 0 && pos.height === 0)) {
				return;
			}
			if(pos.left + pos.width < limit) {
				if(!map[page-1]){
					range.collapse(true);
					cfi = renderer.getCurrentChapter().cfiFromRange(range);
					// map[page-1].start = cfi;
					result = map.push({ start: cfi, end: null });
				}
			} else {
				// Previous Range is null since we already found our last map pair
				// Use that last walked textNode
				if(!prevRange && prevElement) {
					prevRanges = renderer.splitTextNodeIntoWordsRanges(prevElement);
					prevRange = prevRanges[prevRanges.length-1];
				}

				if(prevRange){
					prevRange.collapse(false);
					cfi = renderer.getCurrentChapter().cfiFromRange(prevRange);
					map[map.length-1].end = cfi;
				}

				range.collapse(true);
				cfi = renderer.getCurrentChapter().cfiFromRange(range);
				result = map.push({
						start: cfi,
						end: null
				});

				page += 1;
				limit = (width * page) - offset;
				elLimit = limit;
			}

			prevRange = range;
		});

		return result;
	};
	var docEl = this.getVisibleRender().getDocumentElement();
	var dir = docEl.dir;

	// Set back to ltr before sprinting to get correct order
	if(dir == "rtl") {
		docEl.dir = "ltr";
		if (this.layoutSettings.layout !== "pre-paginated") {
			docEl.style.position = "static";
		}
	}

	this.textSprint(root, check);

	// Reset back to previous RTL settings
	if(dir == "rtl") {
		docEl.dir = dir;
		if (this.layoutSettings.layout !== "pre-paginated") {
			docEl.style.left = "auto";
			docEl.style.right = "0";
		}
	}

	// Check the remaining children that fit on this page
	// to ensure the end is correctly calculated
	if(!prevRange && prevElement) {
		prevRanges = renderer.splitTextNodeIntoWordsRanges(prevElement);
		prevRange = prevRanges[prevRanges.length-1];
	}

	if(prevRange){
		prevRange.collapse(false);
		cfi = renderer.getCurrentChapter().cfiFromRange(prevRange);
		map[map.length-1].end = cfi;
	}

	// Handle empty map
	if(!map.length) {
		startRange = this.doc.createRange();
		startRange.selectNodeContents(root);
		startRange.collapse(true);
		startCfi = renderer.getCurrentChapter().cfiFromRange(startRange);

		endRange = this.doc.createRange();
		endRange.selectNodeContents(root);
		endRange.collapse(false);
		endCfi = renderer.getCurrentChapter().cfiFromRange(endRange);


		map.push({ start: startCfi, end: endCfi });

	}

	// clean up
	prevRange = null;
	prevRanges = undefined;
	startRange = null;
	endRange = null;
	root = null;

	return map;
};


EPUBJS.Renderer.prototype.indexOfBreakableChar = function (text, startPosition) {
	var whiteCharacters = "\x2D\x20\t\r\n\b\f";
	// '-' \x2D
	// ' ' \x20

	if (! startPosition) {
		startPosition = 0;
	}

	for (var i = startPosition; i < text.length; i++) {
		if (whiteCharacters.indexOf(text.charAt(i)) != -1) {
			return i;
		}
	}

	return -1;
};


EPUBJS.Renderer.prototype.splitTextNodeIntoWordsRanges = function(node){
	var ranges = [];
	var text = node.textContent.trim();
	var range;
	var rect;
	var list;

	// Usage of indexOf() function for space character as word delimiter
	// is not sufficient in case of other breakable characters like \r\n- etc
	var pos = this.indexOfBreakableChar(text);

	if(pos === -1) {
		range = this.doc.createRange();
		range.selectNodeContents(node);
		return [range];
	}

	range = this.doc.createRange();
	range.setStart(node, 0);
	range.setEnd(node, pos);
	ranges.push(range);

	// there was a word miss in case of one letter words
	range = this.doc.createRange();
	range.setStart(node, pos+1);

	while ( pos != -1 ) {

		pos = this.indexOfBreakableChar(text, pos + 1);
		if(pos > 0) {

			if(range) {
				range.setEnd(node, pos);
				ranges.push(range);
			}

			range = this.doc.createRange();
			range.setStart(node, pos+1);
		}
	}

	if(range) {
		range.setEnd(node, text.length);
		ranges.push(range);
	}

	return ranges;
};

EPUBJS.Renderer.prototype.rangePosition = function(range){
	var rect;
	var list;

	list = range.getClientRects();

	if(list.length) {
		rect = list[0];
		return rect;
	}

	return null;
};

/*
// Get the cfi of the current page
EPUBJS.Renderer.prototype.getPageCfi = function(prevEl){
	var range = this.doc.createRange();
	var position;
	// TODO : this might need to take margin / padding into account?
	var x = 1;//this.formated.pageWidth/2;
	var y = 1;//;this.formated.pageHeight/2;

	range = this.getRange(x, y);

	// var test = this.doc.defaultView.getSelection();
	// var r = this.doc.createRange();
	// test.removeAllRanges();
	// r.setStart(range.startContainer, range.startOffset);
	// r.setEnd(range.startContainer, range.startOffset + 1);
	// test.addRange(r);

	return this.currentChapter.cfiFromRange(range);
};
*/

// Get the cfi of the current page
EPUBJS.Renderer.prototype.getPageCfi = function(){
	var pg = (this.chapterPos * 2)-1;
	return this.pageMap[pg].start;
};

EPUBJS.Renderer.prototype.getRange = function(x, y, forceElement){
	var range = this.doc.createRange();
	var position;
	forceElement = true; // temp override
	if(typeof document.caretPositionFromPoint !== "undefined" && !forceElement){
		position = this.doc.caretPositionFromPoint(x, y);
		range.setStart(position.offsetNode, position.offset);
	} else if(typeof document.caretRangeFromPoint !== "undefined" && !forceElement){
		range = this.doc.caretRangeFromPoint(x, y);
	} else {
		this.visibileEl = this.findElementAfter(x, y);
		range.setStart(this.visibileEl, 1);
	}

	// var test = this.doc.defaultView.getSelection();
	// var r = this.doc.createRange();
	// test.removeAllRanges();
	// r.setStart(range.startContainer, range.startOffset);
	// r.setEnd(range.startContainer, range.startOffset + 1);
	// test.addRange(r);
	return range;
};

/*
EPUBJS.Renderer.prototype.getVisibleRangeCfi = function(prevEl){
	var startX = 0;
	var startY = 0;
	var endX = this.width-1;
	var endY = this.height-1;
	var startRange = this.getRange(startX, startY);
	var endRange = this.getRange(endX, endY); //fix if carret not avail
	var startCfi = this.currentChapter.cfiFromRange(startRange);
	var endCfi;
	if(endRange) {
		endCfi = this.currentChapter.cfiFromRange(endRange);
	}

	return {
		start: startCfi,
		end: endCfi || false
	};
};
*/

EPUBJS.Renderer.prototype.pagesInCurrentChapter = function() {
	var pgs;
	var length;

	if(!this.pageMap) {
		console.warn("page map not loaded");
		return false;
	}

	length = this.pageMap.length;

	if(this.spreads){
		pgs = Math.ceil(length / 2);
	} else {
		pgs = length;
	}

	return pgs;
};

EPUBJS.Renderer.prototype.currentRenderedPage = function(){
	var pg;

	if(!this.pageMap) {
		console.warn("page map not loaded");
		return false;
	}

	if (this.spreads && this.pageMap.length > 1) {
		pg = this.chapterPos*2;
	} else {
		pg = this.chapterPos;
	}

	return pg;
};

EPUBJS.Renderer.prototype.getRenderedPagesLeft = function(){
	var pg;
	var lastPage;
	var pagesLeft;

	if(!this.pageMap) {
		console.warn("page map not loaded");
		return false;
	}

	lastPage = this.pageMap.length;

	if (this.spreads) {
		pg = this.chapterPos*2;
	} else {
		pg = this.chapterPos;
	}

	pagesLeft = lastPage - pg;
	return pagesLeft;

};

EPUBJS.Renderer.prototype.getVisibleRangeCfi = function(){
	var pg;
	var startRange, endRange;

	if(!this.pageMap) {
		console.warn("page map not loaded");
		return false;
	}

	if (this.spreads) {
		pg = this.chapterPos*2;
		startRange = this.pageMap[pg-2];
		endRange = startRange;

		if(this.pageMap.length > 1 && this.pageMap.length > pg-1) {
			endRange = this.pageMap[pg-1];
		}
	} else {
		pg = this.chapterPos;
		startRange = this.pageMap[pg-1];
		endRange = startRange;
	}

	if(!startRange) {
		console.warn("page range miss:", pg, this.pageMap);
		startRange = this.pageMap[this.pageMap.length-1];
		endRange = startRange;
	}

	return {
		start: startRange.start,
		end: endRange.end
	};
};

// Goto a cfi position in the current chapter
EPUBJS.Renderer.prototype.gotoCfi = function(cfi){
	var pg;
	var marker;
	var range;

	if(this._moving){
		return this._q.enqueue("gotoCfi", arguments);
	}

	if(EPUBJS.core.isString(cfi)){
		cfi = this.epubcfi.parse(cfi);
	}

	if(typeof document.evaluate === 'undefined') {
		marker = this.epubcfi.addMarker(cfi, this.doc);
		if(marker) {
			pg = this.getVisibleRender().getPageNumberByElement(marker);
			// Must Clean up Marker before going to page
			this.epubcfi.removeMarker(marker, this.doc);
			this.page(pg);
		}
	} else {
		range = this.epubcfi.generateRangeFromCfi(cfi, this.doc);
		if(range) {
			// jaroslaw.bielski@7bulls.com
			// It seems that sometimes getBoundingClientRect() returns null for first page CFI in chapter.
			// It is always reproductible if few consecutive chapters have only one page.
			// NOTE: This is only workaround and the issue needs an deeper investigation.
			// NOTE: Observed on Android 4.2.1 using WebView widget as HTML renderer (Asus TF300T).
			var rect = range.getBoundingClientRect();
			if (rect) {
				pg = this.getVisibleRender().getPageNumberByRect(rect);

			} else {
				// Goto first page in chapter
				pg = 1;
			}

			this.page(pg);

			// Reset the current location cfi to requested cfi
			this.currentLocationCfi = cfi.str;
		} else {
			// Failed to find a range, go to first page
			this.page(1);
		}
	}
};

//  Walk nodes until a visible element is found
EPUBJS.Renderer.prototype.findFirstVisible = function(startEl){
	var el = startEl || this.getVisibleRender().getBaseElement();
	var	found;
	// kgolunski@7bulls.com
	// Looks like an old API usage
	// Set x and y as 0 to fullfill walk method API.
	found = this.walk(el, 0, 0);

	if(found) {
		return found;
	}else{
		return startEl;
	}

};
// TODO: remove me - unsused
EPUBJS.Renderer.prototype.findElementAfter = function(x, y, startEl){
	var el = startEl || this.getVisibleRender().getBaseElement();
	var	found;
	found = this.walk(el, x, y);
	if(found) {
		return found;
	}else{
		return el;
	}

};

/*
EPUBJS.Renderer.prototype.route = function(hash, callback){
	var location = window.location.hash.replace('#/', '');
	if(this.useHash && location.length && location != this.prevLocation){
		this.show(location, callback);
		this.prevLocation = location;
		return true;
	}
	return false;
}

EPUBJS.Renderer.prototype.hideHashChanges = function(){
	this.useHash = false;
}

*/

EPUBJS.Renderer.prototype.resize = function(width, height, setSize){
	var spreads;

	this.width = width;
	this.height = height;

	if(setSize !== false) {
		this.renders.forEach(function(render) {
			render.resize(this.width, this.height);
		}, this);
	}



	if(this.contents){
		this.reformat();
	}

	this.trigger("renderer:resized", {
		width: this.width,
		height: this.height
	});
};

//-- Listeners for events in the frame

EPUBJS.Renderer.prototype.onResized = function(e) {
	var width = this.container.clientWidth;
	var height = this.container.clientHeight;

	this.resize(width, height, false);
};

EPUBJS.Renderer.prototype.addEventListeners = function(render){
	if(!render.document) {
		return;
	}
	this.listenedEvents.forEach(function(eventName){
		render.document.addEventListener(eventName, this.triggerEvent.bind(this), false);
	}, this);

};

EPUBJS.Renderer.prototype.removeEventListeners = function(render){
	if(!render.document) {
		return;
	}
	this.listenedEvents.forEach(function(eventName){
		render.document.removeEventListener(eventName, this.triggerEvent, false);
	}, this);

};

// Pass browser events
EPUBJS.Renderer.prototype.triggerEvent = function(e){
	this.trigger("renderer:"+e.type, e);
};

EPUBJS.Renderer.prototype.addSelectionListeners = function(render){
	render.selectionListener = function(e) {
		this.onSelectionChange(e, render);
	}.bind(this);
	render.document.addEventListener("selectionchange", render.selectionListener, false);
};

EPUBJS.Renderer.prototype.removeSelectionListeners = function(render){
	if(!render.document) {
		return;
	}
	render.document.removeEventListener("selectionchange", render.selectionListener, false);
};

EPUBJS.Renderer.prototype.onSelectionChange = function(e, render){
	if (this.selectionEndTimeout) {
		clearTimeout(this.selectionEndTimeout);
	}
	this.selectionEndTimeout = setTimeout(function() {
		this.selectedRange = render.window.getSelection();
		this.trigger("renderer:selected", this.selectedRange);
	}.bind(this), 500);
};


//-- Spreads

EPUBJS.Renderer.prototype.setMinSpreadWidth = function(width){
	this.minSpreadWidth = width;
	this.spreads = this.determineSpreads(width);
};

EPUBJS.Renderer.prototype.determineSpreads = function(cutoff){
	if(this.isForcedSingle || !cutoff || this.width < cutoff) {
		return false; //-- Single Page
	}else{
		return true; //-- Double Page
	}
};

EPUBJS.Renderer.prototype.forceSingle = function(bool){
	if(bool) {
		this.isForcedSingle = true;
		// this.spreads = false;
	} else {
		this.isForcedSingle = false;
		// this.spreads = this.determineSpreads(this.minSpreadWidth);
	}
};

EPUBJS.Renderer.prototype.setGap = function(gap){
	this.gap = gap; //-- False == auto gap
};

EPUBJS.Renderer.prototype.setDirection = function(direction){
	this.direction = direction;
	this.renders.forEach(function(render) {
		render.setDirection(this.direction);
	}, this);
};

//-- Content Replacements

EPUBJS.Renderer.prototype.replace = function(query, func, finished, progress){
	this.renders.forEach(function(render) {
		var items = render.docEl.querySelectorAll(query),
			resources = Array.prototype.slice.call(items),
			count = resources.length;


		if(count === 0) {
			finished(false);
			return;
		}
		resources.forEach(function(item){
			var called = false;
			var after = function(result, full){
				if(called === false) {
					count--;
					if(progress) progress(result, full, count);
					if(count <= 0 && finished) finished(true);
					called = true;
				}
			};

			func(item, after);

		}.bind(this));
	}, this);


};

//-- Enable binding events to Renderer
RSVP.EventTarget.mixin(EPUBJS.Renderer.prototype);
