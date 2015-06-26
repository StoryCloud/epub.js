EPUBJS.Hooks.register("beforeChapterDisplay").hypothesis = function(callback, renderer){
		var folder = EPUBJS.core.folder(location.pathname);
		var cssPath = (folder + EPUBJS.cssPath) || folder;
		
		if(!renderer) return;

		setTimeout( function() { $('iframe')[0].contentWindow.hypothesisRole = function (element, options) {
          if(typeof $('iframe')[0].contentWindow.Annotator !== "undefined" && $('iframe')[0].contentWindow.Annotator !== null) {
            console.log('success');
            return new $('iframe')[0].contentWindow.Annotator.Guest(element, options);
          } else {
            return;
          };
        };}, 1000);

		$('iframe')[0].contentWindow.hypothesisConfig = function () {
			return {};
		};

		EPUBJS.core.addScript("https://hypothes.is/embed.js", null, renderer.doc.head);
		
		EPUBJS.core.addCss( cssPath + "annotations.css", null, renderer.doc.head);

		if(callback) callback();		
};