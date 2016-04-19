EPUBJS.reader.TocController = function(toc) {
	var book = this.book;

	var $list = $("#tocView"),
			docfrag = document.createDocumentFragment();

	var currentChapter = false;

	var generateTocItems = function(toc, level) {
		var container = document.createElement("ul");

		if(!level) level = 1;

		toc.forEach(function(chapter) {
			var listitem = document.createElement("li"),
					link = document.createElement("a");
					toggle = document.createElement("a");

			var subitems;

			listitem.id = "toc-"+chapter.id;
			listitem.classList.add('list_item');

			link.textContent = chapter.label;
			link.href = chapter.href;

			link.classList.add('toc_link');

			listitem.appendChild(link);

			if(chapter.subitems.length > 0) {
				level++;
				subitems = generateTocItems(chapter.subitems, level);
				toggle.classList.add('toc_toggle');

				listitem.insertBefore(toggle, link);
				listitem.appendChild(subitems);
			}


			container.appendChild(listitem);

		});

		return container;
	};

	var onShow = function() {
		$list.show();
	};

	var onHide = function() {
		$list.hide();
	};

	// Search through the table of contents for the first entry matching or
	// before `chapter`.
	var getClosestTocEntry = function (chapter) {
		var candidate;
		for (var i = 0; i < toc.length; i += 1) {
			if (toc[i].spinePos <= chapter.spinePos) {
				candidate = toc[i];
			} else {
				break;
			}
		}
		return candidate;
	};

	var chaptersChange = function(chapters) {
		// We want to find the first chronological chapter, but the
		// chapters might not be in that order (e.g. if the book is
		// right-to-left).
		chapters = chapters.slice().sort(function (a, b) {
			return a.spinePos - b.spinePos;
		});

		// Judge the "current chapter" (in terms of toc tracking) by the
		// "first" chapter displayed (in the case of fixed-size epubs
		// where multiple pages are visible).
		var currentChapter = chapters[0];

		// Fixed-size epubs' "chapters" are more like pages, and
		// sometimes the toc reflects that, so find the "starting page"
		// of the fixed-size epub "chapter." For reflowable epubs this
		// will just match the same chapter.
		var tocEntry = getClosestTocEntry(currentChapter);
		if (!tocEntry) {
			return;
		}

		var $item = $list.find("#toc-" + tocEntry.id),
				$current = $list.find(".currentChapter"),
				$open = $list.find('.openChapter');

		if($item.length){

			if ($current.length) {
				var currentId = $current.attr('id').replace(/^toc-/, '');
				if (chapters.some(function (chapter) {
					return chapter.id === currentId;
				})) {
					// In the context of fixed-page epubs
					// when there are multiple pages
					// displayed: If we click on a chapter
					// in the toc, we want that chapter to
					// still look like the "current" one,
					// whether or not half the page is also
					// shared by the end of the previous
					// chapter. Therefore, wait until the
					// last opportunity to "change the
					// current chapter."
					return;
				} else {
					$current.removeClass("currentChapter");
				}
			}

			$item.addClass("currentChapter");

			// $open.removeClass("openChapter");
			$item.parents('li').addClass("openChapter");
		}
	};

	book.on('renderer:chaptersDisplayed', chaptersChange);

	var tocitems = generateTocItems(toc);

	docfrag.appendChild(tocitems);

	$list.append(docfrag);
	$list.find(".toc_link").on("click", function(event){
			var url = this.getAttribute('href');

			event.preventDefault();

			//-- Provide the Book with the url to show
			//   The Url must be found in the books manifest
			book.goto(url);

			$list.find(".currentChapter")
					.addClass("openChapter")
					.removeClass("currentChapter");

			$(this).parent('li').addClass("currentChapter");

	});

	$list.find(".toc_toggle").on("click", function(event){
			var $el = $(this).parent('li'),
					open = $el.hasClass("openChapter");

			event.preventDefault();
			if(open){
				$el.removeClass("openChapter");
			} else {
				$el.addClass("openChapter");
			}
	});

	return {
		"show" : onShow,
		"hide" : onHide
	};
};
