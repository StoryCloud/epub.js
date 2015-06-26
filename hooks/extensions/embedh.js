window.hypothesisRole = function (element, options) {
	if(typeof Annotator !== "undefined" && Annotator !== null) {
		return new Annotator.Guest(element, options);
	};
};

window.hypothesisConfig = function () {
	return {};
};
