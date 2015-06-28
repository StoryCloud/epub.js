EPUBJS.Hooks.register("beforeChapterDisplay").hypothesis = function(callback, renderer){
		var folder = EPUBJS.core.folder(location.pathname);
		var cssPath = (folder + EPUBJS.cssPath) || folder;
		
		if(!renderer) return;

		EPUBJS.core.addScript("/hooks/extensions/embedh.js", null, renderer.doc.head);

		EPUBJS.core.addScript("http://localhost:5000/app/embed.js", null, renderer.doc.head);
		
		EPUBJS.core.addCss( cssPath + "annotations.css", null, renderer.doc.head);

		if(callback) callback();		
};